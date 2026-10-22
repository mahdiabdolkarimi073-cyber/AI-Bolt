export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="fa" dir="rtl">
      <body className="bg-slate-900 text-slate-100 min-h-screen font-sans">
        {children}
      </body>
    </html>
  )
}
