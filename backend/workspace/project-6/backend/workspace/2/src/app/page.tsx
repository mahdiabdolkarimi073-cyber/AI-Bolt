export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-between p-24">
      <div className="z-10 max-w-5xl w-full items-center justify-between font-mono text-sm lg:flex">
        <p className="fixed left-0 top-0 flex w-full justify-center border-b border-gray-300 bg-gradient-to-b from-zinc-200 pb-6 pt-8 backdrop-blur-2xl dark:border-neutral-850 dark:bg-zinc-800/30 dark:from-inherit lg:static lg:w-auto  lg:rounded-xl lg:border lg:bg-gray-200 lg:p-4 lg:dark:bg-zinc-800/30">
          پروژه &nbsp;<code className="font-bold">agent-next-test</code> با موفقیت ایجاد شد!
        </p>
      </div>

      <div className="flex flex-col items-center justify-center text-center my-auto">
        <h1 className="text-4xl font-extrabold tracking-tight mb-4 text-cyan-400">
          خوش آمدید به Next.js با App Router و TypeScript
        </h1>
        <p className="text-lg text-slate-400 max-w-2xl">
          این پروژه به‌صورت خودکار توسط هوش مصنوعی در محیط کاربری شما ساخته شده و آماده توسعه است.
        </p>
      </div>

      <div className="mb-32 grid text-center lg:max-w-5xl lg:w-full lg:grid-cols-3 lg:text-left gap-4">
        <div className="group rounded-lg border border-transparent px-5 py-4 transition-colors hover:border-gray-300 hover:bg-gray-100 hover:dark:border-neutral-700 hover:dark:bg-neutral-800/30">
          <h2 className="mb-3 text-2xl font-semibold">استارتر App Router</h2>
          <p className="m-0 max-w-[30ch] text-sm text-opacity-50 text-slate-400">
            پشتیبانی کامل از ساختار جدید و مدرن App Router در Next.js.
          </p>
        </div>

        <div className="group rounded-lg border border-transparent px-5 py-4 transition-colors hover:border-gray-300 hover:bg-gray-100 hover:dark:border-neutral-700 hover:dark:bg-neutral-800/30">
          <h2 className="mb-3 text-2xl font-semibold">تایپ‌اسکریپت</h2>
          <p className="m-0 max-w-[30ch] text-sm text-opacity-50 text-slate-400">
            امنیت نوع داده‌ها و توسعه پیشرفته با TypeScript.
          </p>
        </div>

        <div className="group rounded-lg border border-transparent px-5 py-4 transition-colors hover:border-gray-300 hover:bg-gray-100 hover:dark:border-neutral-700 hover:dark:bg-neutral-800/30">
          <h2 className="mb-3 text-2xl font-semibold">تلویند CSS</h2>
          <p className="m-0 max-w-[30ch] text-sm text-opacity-50 text-slate-400">
            طراحی سریع و ریسپانسیو با Tailwind CSS.
          </p>
        </div>
      </div>
    </main>
  )
}
