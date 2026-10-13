import Image from "next/image"
import { AuthView } from "@daveyplate/better-auth-ui"
import { authViewPaths } from "@daveyplate/better-auth-ui/server"

export const dynamicParams = false

export function generateStaticParams() {
  return Object.values(authViewPaths).map((path) => ({ path }))
}

export default async function AuthPage({
  params,
}: {
  params: Promise<{ path: string }>
}) {
  const { path } = await params

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      {/*
        What the visitor is signing in to. `AppChrome` leaves these routes
        unframed, and the sidebar it used to draw was the only thing on the page
        naming the product, so the name says it here instead of nowhere.
      */}
      <div className="flex items-center gap-2.5">
        <Image
          src="/icon.svg"
          alt=""
          width={32}
          height={32}
          className="h-8 w-8 rounded-md"
          priority
        />
        <div>
          <p className="text-sm font-semibold tracking-tight">Content Crew</p>
          <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            Content Engine
          </p>
        </div>
      </div>
      <AuthView path={path} />
    </main>
  )
}
