"""Experience retrieval and Gemini-vs-local decision logic.

Before sending a request to Gemini, the Agent consults this module to
determine whether a sufficiently confident local experience can answer
the user's request directly.

Decision rules (conservative by design):
  - Only 'confirmed' experiences with confidence >= MIN_CONFIDENCE are
    candidates for local execution.
  - Requests involving multiple file changes, auth, destructive ops,
    architecture decisions, or complex/ambiguous wording are ALWAYS routed
    to Gemini.
  - The similarity score must exceed a threshold; surface similarity alone
    is not enough — project type and framework must also match when the
    experience is scoped to them.
  - When in doubt, Gemini is called. The decision and reason are logged.
"""
from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from typing import Optional

from app.experience_repos import ExperienceRepo, DecisionLogRepo


# --- Configuration ---

MIN_CONFIDENCE_FOR_LOCAL = 5
MIN_SIMILARITY_SCORE = 0.35
MAX_EXPERIENCE_REUSE_CHARS = 6000

# Patterns that ALWAYS force Gemini — too risky or complex for local reuse.
_FORCE_GEMINI_PATTERNS = [
    re.compile(r"(?i)\b(auth|authentication|authorization|login|signup|register|password|oauth|jwt|session)\b"),
    re.compile(r"(?i)\b(delete|remove|drop|destroy|truncate|wipe|migrate|migration)\b"),
    re.compile(r"(?i)\b(architecture|refactor|restructure|rewrite| redesign)\b"),
    re.compile(r"(?i)\b(database|schema|table|column|index|constraint)\b"),
    re.compile(r"(?i)\b(deploy|deployment|production|ci.?cd|pipeline)\b"),
    re.compile(r"(?i)\b(security|vulnerability|xss|csrf|injection|sanitize)\b"),
    re.compile(r"(?i)\b(test|testing|jest|vitest|cypress|playwright)\b"),
    re.compile(r"(?i)\b(performance|optimize|optimization|benchmark|cache)\b"),
]

# Indicators of simple, repetitive tasks suitable for local reuse.
_SIMPLE_TASK_PATTERNS = [
    re.compile(r"(?i)\b(component|page|layout|route|hook|util|utility|helper)\b"),
    re.compile(r"(?i)\b(form|input|button|card|modal|dialog|sidebar|navbar|footer|header)\b"),
    re.compile(r"(?i)\b(styling|css|tailwind|class|className|responsive)\b"),
    re.compile(r"(?i)\b(import|export|default|function|const|arrow)\b"),
    re.compile(r"(?i)\b(api|fetch|axios|request|endpoint|route handler)\b"),
]

# Files that indicate multi-file or architectural changes.
_MULTI_FILE_INDICATORS = re.compile(r"(?i)\b(multiple files|all files|every file|entire project|whole project|restructure)\b")


# --- Data classes ---

@dataclass
class ExperienceMatch:
    experience: dict
    similarity: float
    framework_match: bool
    project_match: bool
    score: float

    def to_dict(self) -> dict:
        return {
            "experience": self.experience,
            "similarity": round(self.similarity, 3),
            "frameworkMatch": self.framework_match,
            "projectMatch": self.project_match,
            "score": round(self.score, 3),
        }


@dataclass
class RoutingDecision:
    use_local: bool
    decision: str  # 'local_experience' | 'gemini'
    reason: str
    experience_id: Optional[str]
    confidence: int
    similarity: float

    def to_dict(self) -> dict:
        return {
            "useLocal": self.use_local,
            "decision": self.decision,
            "reason": self.reason,
            "experienceId": self.experience_id,
            "confidence": self.confidence,
            "similarity": round(self.similarity, 3),
        }


# --- Public API ---

def retrieve_experiences(
    conn: sqlite3.Connection,
    *,
    message: str,
    project_id: Optional[str] = None,
    framework: Optional[str] = None,
    limit: int = 5,
) -> list[ExperienceMatch]:
    """Find and rank experiences relevant to the user's message."""
    candidates = ExperienceRepo.find_similar(
        conn,
        message=message,
        project_id=project_id,
        framework=framework,
        limit=limit * 2,
    )
    if not candidates:
        return []

    message_lower = message.lower()
    message_terms = _tokenize(message)
    matches: list[ExperienceMatch] = []

    for exp in candidates:
        sim = _similarity_score(message_lower, message_terms, exp)
        fw_match = _framework_matches(exp, framework)
        proj_match = _project_matches(exp, project_id)

        # Score: similarity weighted by framework/project match and confidence.
        score = sim
        if fw_match:
            score += 0.15
        if proj_match:
            score += 0.10
        score += 0.03 * int(exp.get("confidence", 0))
        if exp.get("status") == "confirmed":
            score += 0.10
        elif exp.get("status") == "proposed":
            score -= 0.05

        matches.append(ExperienceMatch(
            experience=exp,
            similarity=sim,
            framework_match=fw_match,
            project_match=proj_match,
            score=score,
        ))

    matches.sort(key=lambda m: m.score, reverse=True)
    return matches[:limit]


def should_use_local(
    conn: sqlite3.Connection,
    *,
    message: str,
    project_id: Optional[str] = None,
    framework: Optional[str] = None,
    has_open_project: bool = False,
) -> tuple[RoutingDecision, Optional[ExperienceMatch]]:
    """Decide whether to answer locally from an experience or call Gemini.

    Returns (RoutingDecision, optional ExperienceMatch). When the decision is
    'local_experience', the match contains the experience to reuse. When
    'gemini', the match (if any) is still returned for context injection.
    """
    # 1. Force Gemini for complex/risky patterns.
    forced = _check_force_gemini(message)
    if forced:
        return RoutingDecision(
            use_local=False,
            decision="gemini",
            reason=forced,
            experience_id=None,
            confidence=0,
            similarity=0.0,
        ), None

    # 2. Check for multi-file or architectural indicators.
    if _MULTI_FILE_INDICATORS.search(message):
        return RoutingDecision(
            use_local=False,
            decision="gemini",
            reason="Multi-file or architectural change detected — requires Gemini.",
            experience_id=None,
            confidence=0,
            similarity=0.0,
        ), None

    # 3. Retrieve matching experiences.
    matches = retrieve_experiences(
        conn,
        message=message,
        project_id=project_id,
        framework=framework,
        limit=3,
    )
    if not matches:
        return RoutingDecision(
            use_local=False,
            decision="gemini",
            reason="No relevant experiences found.",
            experience_id=None,
            confidence=0,
            similarity=0.0,
        ), None

    best = matches[0]

    # 4. Check minimum thresholds.
    if best.similarity < MIN_SIMILARITY_SCORE:
        return RoutingDecision(
            use_local=False,
            decision="gemini",
            reason=f"Best experience similarity ({best.similarity:.2f}) below threshold ({MIN_SIMILARITY_SCORE}).",
            experience_id=best.experience["id"],
            confidence=best.experience.get("confidence", 0),
            similarity=best.similarity,
        ), best

    if best.experience.get("status") != "confirmed":
        return RoutingDecision(
            use_local=False,
            decision="gemini",
            reason="Best experience is not confirmed — using Gemini for safety.",
            experience_id=best.experience["id"],
            confidence=best.experience.get("confidence", 0),
            similarity=best.similarity,
        ), best

    if best.experience.get("confidence", 0) < MIN_CONFIDENCE_FOR_LOCAL:
        return RoutingDecision(
            use_local=False,
            decision="gemini",
            reason=f"Experience confidence ({best.experience.get('confidence', 0)}) below minimum ({MIN_CONFIDENCE_FOR_LOCAL}).",
            experience_id=best.experience["id"],
            confidence=best.experience.get("confidence", 0),
            similarity=best.similarity,
        ), best

    # 5. If experience is project-scoped but project doesn't match, don't use locally.
    if not best.project_match and best.experience.get("projectId") is not None:
        return RoutingDecision(
            use_local=False,
            decision="gemini",
            reason="Experience is scoped to a different project.",
            experience_id=best.experience["id"],
            confidence=best.experience.get("confidence", 0),
            similarity=best.similarity,
        ), best

    # 6. Check that the request looks like a simple/repetitive task.
    if not _looks_like_simple_task(message):
        return RoutingDecision(
            use_local=False,
            decision="gemini",
            reason="Request does not match simple/repetitive task patterns.",
            experience_id=best.experience["id"],
            confidence=best.experience.get("confidence", 0),
            similarity=best.similarity,
        ), best

    # 7. All checks passed — use local experience.
    return RoutingDecision(
        use_local=True,
        decision="local_experience",
        reason=f"Confirmed experience matched (similarity={best.similarity:.2f}, confidence={best.experience.get('confidence', 0)}).",
        experience_id=best.experience["id"],
        confidence=best.experience.get("confidence", 0),
        similarity=best.similarity,
    ), best


def build_local_response(match: ExperienceMatch) -> str:
    """Build a response from a confirmed experience, clearly labeled as
    reused from prior work — not freshly generated by Gemini."""
    exp = match.experience
    pattern = exp.get("solutionPattern", "")
    if len(pattern) > MAX_EXPERIENCE_REUSE_CHARS:
        pattern = pattern[:MAX_EXPERIENCE_REUSE_CHARS] + "\n… [truncated]"
    title = exp.get("title", "Untitled")
    files = exp.get("filesInvolved", [])
    files_str = ", ".join(files[:5]) if files else "(not specified)"

    lines = [
        f"[Reused from confirmed experience: {title}]",
        "",
        "This answer is based on a previously confirmed solution pattern,",
        "not a fresh Gemini call. Please review the code below against your",
        "current project context before applying.",
        "",
        f"Files typically involved: {files_str}",
        "",
        "--- Solution Pattern ---",
        pattern,
    ]
    return "\n".join(lines)


def log_decision(
    conn: sqlite3.Connection,
    *,
    request_id: str,
    conversation_id: Optional[str],
    decision: RoutingDecision,
    project_id: Optional[str] = None,
    framework: Optional[str] = None,
    success: Optional[bool] = None,
    duration_ms: Optional[int] = None,
) -> None:
    """Persist a routing decision to the decision log."""
    DecisionLogRepo.log(
        conn,
        request_id=request_id,
        conversation_id=conversation_id,
        decision=decision.decision,
        reason=decision.reason,
        experience_id=decision.experience_id,
        project_id=project_id,
        framework=framework,
        confidence=decision.confidence,
        success=success,
        duration_ms=duration_ms,
    )


# --- Internal helpers ---

def _check_force_gemini(message: str) -> Optional[str]:
    """Return a reason string if the message must go to Gemini, else None."""
    for pat in _FORCE_GEMINI_PATTERNS:
        m = pat.search(message)
        if m:
            return f"Force-Gemini keyword detected: '{m.group(0)}'."
    return None


def _looks_like_simple_task(message: str) -> bool:
    """Heuristic: does this message look like a simple, repetitive task?"""
    return any(pat.search(message) for pat in _SIMPLE_TASK_PATTERNS)


def _tokenize(text: str) -> set[str]:
    return set(re.split(r"[^a-z0-9_]+", text.lower())) - {""}


def _similarity_score(message_lower: str, message_terms: set[str], exp: dict) -> float:
    """Compute a 0-1 similarity score between the message and an experience."""
    title = exp.get("title", "").lower()
    problem = exp.get("problemDescription", "").lower()
    tags = [t.lower() for t in exp.get("tags", [])]

    if not message_terms:
        return 0.0

    title_terms = set(title.split())
    problem_terms = set(problem.split())
    tag_terms = set(tags)

    hits = 0
    for t in message_terms:
        if t in title_terms:
            hits += 3
        if t in tag_terms:
            hits += 2
        if t in problem_terms:
            hits += 1

    if not hits:
        return 0.0

    # Normalize: more terms with hits = higher score, but penalize very long messages.
    score = hits / (len(message_terms) ** 0.5)
    # Cap at 1.0.
    return min(1.0, score / 10.0)


def _framework_matches(exp: dict, framework: Optional[str]) -> bool:
    exp_fw = exp.get("framework")
    if not exp_fw:
        return True  # No framework constraint — matches anything.
    if not framework:
        return False
    return exp_fw.lower() == framework.lower()


def _project_matches(exp: dict, project_id: Optional[str]) -> bool:
    exp_pid = exp.get("projectId")
    if not exp_pid:
        return True  # Global experience — matches any project.
    if not project_id:
        return False
    return exp_pid == project_id
