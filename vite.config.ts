import { defineConfig, loadEnv, type HtmlTagDescriptor, type Plugin } from "vite"

import react from "@vitejs/plugin-react"

import tailwindcss from "@tailwindcss/vite"

import path from "node:path"
import { randomBytes } from "node:crypto"

import siteConfiguration from "./.figma/make/site.json" with { type: "json" }

// Vite config — https://vitejs.dev/config/

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  Object.assign(process.env, env)
  // .figma/make/deploy-preview passes `--mode development` for cached-preview builds.

  const emitSourcemaps = mode === "development"

  return {
    base: process.env.FIGMA_PUBLIC_URL
      ? `${process.env.FIGMA_PUBLIC_URL}/`
      : "/",

    build: {
      sourcemap: emitSourcemaps ? "inline" : false,

      minify: !emitSourcemaps,
    },

    plugins: [
      react(),
      tailwindcss(),
      githubAuthPlugin(),
      groqApiPlugin(),
      figmaSiteConfiguration(siteConfiguration),
      figmaErrorOverlayReplay(),

      figmaReactRefreshBoundaryFallback(),

      figmaMakeKitPlugin({ storiesGlob: "/src/**/*.stories.{ts,tsx,js,jsx}" }),
    ],

    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },

    server: {
      host: process.env.FIGMA_DEV_SERVER_HOST || "0.0.0.0",

      port: parseInt(process.env.PORT || "8443"),

      strictPort: false,

      watch: {
        ignored: ["**/.figma/**"],
      },
    },

    preview: {
      host: process.env.FIGMA_DEV_SERVER_HOST || "0.0.0.0",

      port: parseInt(process.env.PORT || "8443"),
    },
  }
})

type GitHubSession = {
  accessToken: string
  user: { login: string; name: string; avatarUrl: string }
}

function githubAuthPlugin(): Plugin {
  const sessions = new Map<string, GitHubSession>()
  const pendingStates = new Map<string, { returnTo: string; createdAt: number }>()
  const getClientId = () => process.env.GITHUB_CLIENT_ID || ""
  const getClientSecret = () => process.env.GITHUB_CLIENT_SECRET || ""
  const isConfigured = () => Boolean(getClientId() && getClientSecret())
  const parseCookies = (header: string | undefined) =>
    Object.fromEntries(
      (header || "")
        .split(";")
        .map((part) => part.trim().split("=").map(decodeURIComponent))
        .filter((pair) => pair.length === 2),
    )
  const sendJson = (res: any, status: number, value: unknown) => {
    res.statusCode = status
    res.setHeader("Content-Type", "application/json; charset=utf-8")
    res.end(JSON.stringify(value))
  }
  const sessionFor = (req: any) =>
    sessions.get(parseCookies(req.headers.cookie).devpilot_session || "")
  const safeReturnTo = (value: string | null) =>
    value && value.startsWith("/") && !value.startsWith("//")
      ? value
      : "/?github=connected"

  const install = (middlewares: {
    use: (
      handler: (req: any, res: any, next: () => void) => void,
    ) => void
  }) => {
    middlewares.use(async (req, res, next) => {
      const requestUrl = new URL(
        req.url || "/",
        `http://${req.headers.host || "localhost"}`,
      )
      const pathname = requestUrl.pathname
      if (
        !pathname.startsWith("/api/auth/") &&
        !pathname.startsWith("/api/github/")
      )
        return next()

      try {
        if (pathname === "/api/auth/status" && req.method === "GET") {
          const session = sessionFor(req)
          sendJson(res, 200, {
            configured: isConfigured(),
            authenticated: Boolean(session),
            user: session?.user || null,
          })
          return
        }
        if (pathname === "/api/auth/github" && req.method === "GET") {
          if (!isConfigured()) {
            sendJson(res, 503, {
              error:
                "GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.",
            })
            return
          }
          const state = randomBytes(24).toString("hex")
          pendingStates.set(state, {
            returnTo: safeReturnTo(requestUrl.searchParams.get("returnTo")),
            createdAt: Date.now(),
          })
          const origin = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers["x-forwarded-host"] || req.headers.host}`
          const authorize = new URL("https://github.com/login/oauth/authorize")
          authorize.searchParams.set("client_id", getClientId())
          const callbackUrl =
            process.env.GITHUB_CALLBACK_URL || `${origin}/api/auth/callback`
          authorize.searchParams.set("redirect_uri", callbackUrl)
          authorize.searchParams.set("scope", "read:user repo")
          authorize.searchParams.set("state", state)
          res.statusCode = 302
          res.setHeader("Location", authorize.toString())
          res.end()
          return
        }
        if (pathname === "/api/auth/callback" && req.method === "GET") {
          const code = requestUrl.searchParams.get("code")
          const state = requestUrl.searchParams.get("state") || ""
          const pending = pendingStates.get(state)
          pendingStates.delete(state)
          if (
            !code ||
            !pending ||
            Date.now() - pending.createdAt > 10 * 60_000
          ) {
            res.statusCode = 302
            res.setHeader("Location", "/?github=error")
            res.end()
            return
          }
          const tokenResponse = await fetch(
            "https://github.com/login/oauth/access_token",
            {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                client_id: getClientId(),
                client_secret: getClientSecret(),
                code,
              }),
            },
          )
          const tokenData = (await tokenResponse.json()) as any
          if (!tokenResponse.ok || !tokenData.access_token)
            throw new Error(
              tokenData.error_description || "GitHub authorization failed.",
            )
          const userResponse = await fetch("https://api.github.com/user", {
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "DevPilot",
            },
          })
          if (!userResponse.ok)
            throw new Error("Unable to load the authorized GitHub user.")
          const user = (await userResponse.json()) as any
          const sessionId = randomBytes(32).toString("hex")
          sessions.set(sessionId, {
            accessToken: tokenData.access_token,
            user: {
              login: user.login,
              name: user.name || user.login,
              avatarUrl: user.avatar_url,
            },
          })
          const secure = req.headers["x-forwarded-proto"] === "https"
          res.setHeader(
            "Set-Cookie",
            `devpilot_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${secure ? "; Secure" : ""}`,
          )
          res.statusCode = 302
          res.setHeader("Location", pending.returnTo)
          res.end()
          return
        }
        if (pathname === "/api/auth/logout" && req.method === "POST") {
          const id = parseCookies(req.headers.cookie).devpilot_session || ""
          sessions.delete(id)
          res.setHeader(
            "Set-Cookie",
            "devpilot_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
          )
          sendJson(res, 200, { authenticated: false })
          return
        }

        const session = sessionFor(req)
        if (!session) {
          sendJson(res, 401, {
            error: "Sign in with GitHub before accessing repositories.",
          })
          return
        }
        const githubHeaders: Record<string, string> = {
          Authorization: `Bearer ${session.accessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "DevPilot",
        }
        let target = ""
        if (pathname === "/api/github/rest") {
          const apiPath = requestUrl.searchParams.get("path") || ""
          if (!apiPath.startsWith("/") || apiPath.includes("://")) {
            sendJson(res, 400, { error: "Invalid GitHub API path." })
            return
          }
          target = `https://api.github.com${apiPath}`
        } else if (pathname === "/api/github/file") {
          const owner = requestUrl.searchParams.get("owner") || ""
          const repo = requestUrl.searchParams.get("repo") || ""
          const branch = requestUrl.searchParams.get("branch") || ""
          const filePath = requestUrl.searchParams.get("path") || ""
          if (
            ![owner, repo, branch, filePath].every(Boolean) ||
            !/^[\w.-]+$/.test(owner) ||
            !/^[\w.-]+$/.test(repo)
          ) {
            sendJson(res, 400, { error: "Invalid repository file request." })
            return
          }
          target = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath
            .split("/")
            .map(encodeURIComponent)
            .join("/")}?ref=${encodeURIComponent(branch)}`
          githubHeaders.Accept = "application/vnd.github.raw+json"
        } else {
          sendJson(res, 404, { error: "GitHub proxy route not found." })
          return
        }
        const upstream = await fetch(target, { headers: githubHeaders })
        const body = Buffer.from(await upstream.arrayBuffer())
        res.statusCode = upstream.status
        res.setHeader(
          "Content-Type",
          upstream.headers.get("content-type") ||
            "application/json; charset=utf-8",
        )
        for (const header of [
          "x-ratelimit-limit",
          "x-ratelimit-remaining",
          "x-ratelimit-reset",
          "retry-after",
        ]) {
          const value = upstream.headers.get(header)
          if (value) res.setHeader(header, value)
        }
        res.end(body)
      } catch (error) {
        sendJson(res, 500, {
          error:
            error instanceof Error
              ? error.message
              : "GitHub authentication failed.",
        })
      }
    })
  }

  return {
    name: "devpilot-github-auth",
    configureServer(server) {
      install(server.middlewares)
    },
    configurePreviewServer(server) {
      install(server.middlewares)
    },
  }
}

function groqApiPlugin(): Plugin {
  const route = "/api/ai"
  const model = process.env.GROQ_MODEL || "openai/gpt-oss-20b"

  const install = (middlewares: {
    use: (handler: (req: any, res: any, next: () => void) => void) => void
  }) => {
    middlewares.use(async (req, res, next) => {
      const pathname = (req.url || "").split("?")[0]
      if (!pathname?.startsWith(route)) return next()

      res.setHeader("Content-Type", "application/json; charset=utf-8")
      if (req.method === "GET" && pathname === `${route}/status`) {
        res.end(
          JSON.stringify({
            configured: Boolean(process.env.GROQ_API_KEY),
            model,
          }),
        )
        return
      }
      if (req.method !== "POST" || pathname !== `${route}/generate`) {
        res.statusCode = 404
        res.end(JSON.stringify({ error: "AI route not found." }))
        return
      }
      if (!process.env.GROQ_API_KEY) {
        res.statusCode = 503
        res.end(
          JSON.stringify({
            error: "GROQ_API_KEY is not configured on the server.",
          }),
        )
        return
      }

      try {
        let raw = ""
        for await (const chunk of req) {
          raw += chunk
          if (raw.length > 180_000)
            throw new Error("AI request context is too large.")
        }
        const payload = JSON.parse(raw || "{}") as {
          task?: string
          context?: unknown
        }
        if (payload.task !== "explain" && payload.task !== "generate-test") {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "Unsupported AI task." }))
          return
        }
        const system =
          payload.task === "explain"
            ? "You are DevPilot, a source-grounded code explainer. Use only the supplied repository context. Clearly separate confirmed source evidence, reasonable inference, and unknowns. Cite file paths and line numbers when present. Never invent files, functions, test results, or execution evidence."
            : "You are DevPilot TestTwin. Generate one focused, reviewable regression test using only the supplied issue, framework, and source context. Return code followed by a short assumptions list. Use TODO comments where repository-specific fixtures or imports are unknown. Never claim the test was executed."
        const response = await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              temperature: 0.2,
              // The configured model's free tier permits 8K tokens/minute.
              // Reserve enough headroom for source context and system text.
              max_completion_tokens: 1200,
              messages: [
                { role: "system", content: system },
                {
                  role: "user",
                  content: JSON.stringify(payload.context ?? {}),
                },
              ],
            }),
          },
        )
        const data = (await response.json()) as any
        if (!response.ok) {
          res.statusCode = response.status
          res.end(
            JSON.stringify({
              error:
                response.status === 429
                  ? "Groq's current rate limit was reached. Wait a minute and try again; DevPilot now sends a smaller source excerpt to stay within the free-tier limit."
                  : data?.error?.message ||
                    `Groq request failed (${response.status}).`,
            }),
          )
          return
        }
        const content = data?.choices?.[0]?.message?.content
        if (typeof content !== "string")
          throw new Error("Groq returned no text content.")
        res.end(
          JSON.stringify({
            content,
            model: data.model || model,
            usage: data.usage || null,
          }),
        )
      } catch (error) {
        res.statusCode = 500
        res.end(
          JSON.stringify({
            error:
              error instanceof Error ? error.message : "AI request failed.",
          }),
        )
      }
    })
  }

  return {
    name: "devpilot-groq-api",
    configureServer(server) {
      install(server.middlewares)
    },
    configurePreviewServer(server) {
      install(server.middlewares)
    },
  }
}

type FigmaSiteConfiguration = {
  title?: string

  description?: string

  language?: string

  robots?: {
    index?: boolean
  }

  icons?: {
    icon?: string
  }

  openGraph?: {
    image?: string
  }

  analytics?: {
    googleAnalyticsId?: string
  }

  customScripts?: {
    headStart?: string

    headEnd?: string

    bodyStart?: string

    bodyEnd?: string
  }

  accessibility?: {
    addBypassLinks?: boolean
  }
}

/** Applies /.figma/make/site.json to the generated document shell. */

function figmaSiteConfiguration(config: FigmaSiteConfiguration): Plugin {
  function sanitizeHtmlValue(value: string | undefined): string {
    return value?.replace(/[^a-zA-Z0-9_-]/g, "") || ""
  }

  function escapeHtmlText(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  }

  function replaceHtmlCommentSlot(
    html: string,
    slotName: string,
    content: string,
  ): string {
    return html.replace(`<!-- ${slotName} -->`, content)
  }

  const title = config.title ?? "Figma Make App"

  const description = config.description ?? ""

  // Imported HTML keeps its own favicon; new Makes default to the Make product icon.

  const favicon = config.icons?.icon ?? "/favicon.svg"

  const socialImage = config.openGraph?.image ?? ""

  const language = sanitizeHtmlValue(config.language) || "en"

  const googleAnalyticsId = sanitizeHtmlValue(
    config.analytics?.googleAnalyticsId,
  )

  const headStart = config.customScripts?.headStart ?? ""

  const headEnd = config.customScripts?.headEnd ?? ""

  const bodyStart = config.customScripts?.bodyStart ?? ""

  const bodyEnd = config.customScripts?.bodyEnd ?? ""

  const robotsTxt =
    config.robots?.index === false ? "User-agent: *\nDisallow: /\n" : ""

  return {
    name: "figma-site-configuration",

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!robotsTxt || req.url?.split("?")[0] !== "/robots.txt")
          return next()

        res.setHeader("Content-Type", "text/plain; charset=utf-8")

        res.end(robotsTxt)
      })
    },

    generateBundle() {
      if (!robotsTxt) return

      this.emitFile({
        type: "asset",

        fileName: "robots.txt",

        source: robotsTxt,
      })
    },

    transformIndexHtml: {
      order: "pre",

      handler(html) {
        let result = html

        result = replaceHtmlCommentSlot(result, "figma:lang", language)

        result = replaceHtmlCommentSlot(
          result,
          "figma:title",
          escapeHtmlText(title),
        )

        result = replaceHtmlCommentSlot(result, "figma:head-start", headStart)

        result = replaceHtmlCommentSlot(result, "figma:head-end", headEnd)

        result = replaceHtmlCommentSlot(result, "figma:body-start", bodyStart)

        result = replaceHtmlCommentSlot(result, "figma:body-end", bodyEnd)

        const tags: HtmlTagDescriptor[] = []

        if (description) {
          tags.push({
            tag: "meta",
            attrs: { name: "description", content: description },
            injectTo: "head",
          })
        }

        if (config.robots?.index === false) {
          tags.push({
            tag: "meta",
            attrs: { name: "robots", content: "noindex, nofollow" },
            injectTo: "head",
          })
        }

        if (favicon) {
          tags.push({
            tag: "link",
            attrs: { rel: "icon", href: favicon },
            injectTo: "head",
          })
        }

        if (title) {
          tags.push({
            tag: "meta",
            attrs: { property: "og:title", content: title },
            injectTo: "head",
          })
        }

        if (description) {
          tags.push({
            tag: "meta",
            attrs: { property: "og:description", content: description },
            injectTo: "head",
          })
        }

        if (socialImage) {
          tags.push(
            {
              tag: "meta",
              attrs: { property: "og:image", content: socialImage },
              injectTo: "head",
            },

            {
              tag: "meta",
              attrs: { name: "twitter:card", content: "summary_large_image" },
              injectTo: "head",
            },

            {
              tag: "meta",
              attrs: { name: "twitter:image", content: socialImage },
              injectTo: "head",
            },
          )
        }

        if (googleAnalyticsId) {
          tags.push(
            {
              tag: "script",

              attrs: {
                async: true,

                src: `https://www.googletagmanager.com/gtag/js?id=${googleAnalyticsId}`,
              },

              injectTo: "head",
            },

            {
              tag: "script",

              children: `
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', ${JSON.stringify(googleAnalyticsId)});
`,

              injectTo: "head",
            },
          )
        }

        if (config.accessibility?.addBypassLinks) {
          tags.push(
            {
              tag: "style",

              children: `
  .figma-bypass-link {
    position: fixed;
    top: 8px;
    left: 8px;
    z-index: 2147483647;
    transform: translateY(-150%);
    border-radius: 6px;
    background: #111827;
    color: #fff;
    padding: 8px 12px;
    font: 600 14px/1.2 system-ui, sans-serif;
    text-decoration: none;
  }
  .figma-bypass-link:focus {
    transform: translateY(0);
  }
`,

              injectTo: "head",
            },

            {
              tag: "a",

              attrs: { class: "figma-bypass-link", href: "#root" },

              children: "Skip to content",

              injectTo: "body-prepend",
            },
          )
        }

        return {
          html: result,

          tags,
        }
      },
    },
  }
}

/**
 * Replay the most recent build error to clients that connect after
 * it was first broadcast. Vite buffers an error payload only while
 * no clients are connected and clears the buffer on the first
 * reconnect (see `bufferedMessage` in `createWebSocketServer`), so
 * if the preview iframe reloads after Vite already delivered an
 * error to a live socket, the new socket misses the payload and
 * the overlay stays hidden even though the build is still broken.
 * We intercept `ws.send` to remember the latest error and replay
 * it on every new connection; the cache clears on a successful
 * `update` or `full-reload` so a stale overlay can't survive a
 * fixed build.
 */

function figmaErrorOverlayReplay(): Plugin {
  return {
    name: "figma-error-overlay-replay",

    apply: "serve",

    configureServer(server) {
      let lastError: object | null = null

      const origSend = server.ws.send.bind(server.ws) as (
        ...args: any[]
      ) => void

      server.ws.send = (((...args: any[]) => {
        const payload = args[0]

        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          const type = (payload as { type?: string }).type

          if (type === "error") {
            lastError = (payload as object)
          } else if (type === "update" || type === "full-reload") {
            lastError = null
          }
        }

        return origSend(...args)
      }) as typeof server.ws.send)

      server.ws.on("connection", (socket) => {
        if (lastError !== null) {
          socket.send(JSON.stringify(lastError))
        }
      })
    },
  }
}

/**
 * Reload when a module that previously defined a React Refresh boundary stops
 * defining one. This happens when an agent moves a component into a new file
 * and replaces the old module with a re-export:
 *
 *   export { default } from './app/App'
 *
 * Vite otherwise accepts the update using the previous module's HMR boundary,
 * but the re-export-only transform no longer registers a replacement for the
 * mounted component family. React reports a successful refresh while leaving
 * the old tree mounted until the page is reloaded.
 */

function figmaReactRefreshBoundaryFallback(): Plugin {
  type ModuleNode = import("vite").ModuleNode

  const hadRefreshBoundary = new Map<string, boolean>()

  const lostRefreshBoundaries = new Set<string>()

  let sendFullReload: (() => void) | null = null

  return {
    name: "figma-react-refresh-boundary-fallback",

    apply: "serve",

    enforce: "post",

    configureServer(server) {
      sendFullReload = () => server.ws.send({ type: "full-reload", path: "*" })
    },

    handleHotUpdate({ modules, server, timestamp }) {
      if (lostRefreshBoundaries.size === 0) return

      const visited = new Set<ModuleNode>()

      const pending = [...modules]

      while (pending.length > 0) {
        const current = pending.pop()

        if (!current || visited.has(current)) continue

        visited.add(current)

        const moduleId = current.id?.split("?")[0]

        if (moduleId && lostRefreshBoundaries.has(moduleId)) {
          const invalidated = new Set<ModuleNode>()

          for (const updatedModule of modules) {
            server.moduleGraph.invalidateModule(
              updatedModule,
              invalidated,
              timestamp,
              true,
            )
          }

          sendFullReload?.()

          return []
        }

        pending.push(...current.importers)
      }
    },

    transform(code, id) {
      if (!/\.[jt]sx?(?:\?|$)/.test(id) || id.includes("/node_modules/"))
        return null

      const moduleId = id.split("?")[0] ?? id

      const hasRefreshBoundary = code.includes("registerExportsForReactRefresh")

      const previousHadRefreshBoundary = hadRefreshBoundary.get(moduleId)

      hadRefreshBoundary.set(moduleId, hasRefreshBoundary)

      if (hasRefreshBoundary) lostRefreshBoundaries.delete(moduleId)

      if (previousHadRefreshBoundary && !hasRefreshBoundary) {
        lostRefreshBoundaries.add(moduleId)

        queueMicrotask(() => sendFullReload?.())
      }

      return null
    },
  }
}

/**
 * Serves a blank render-target page at /.figma/make/kit.html that
 * the Figma preview script drives directly. The page exposes a
 * registry of every file matching `storiesGlob` on
 * window.__FIGMA__.stories so the design surface can dynamically
 * import + mount each entry into its own grid view.
 *
 * Dev-only: `apply: 'serve'` gates the plugin to `vite dev`. Prod
 * builds (`vite build`) skip it entirely so the route doesn't leak
 * into shipped bundles.
 */

function figmaMakeKitPlugin(options: {
  storiesGlob: string | string[]
}): Plugin {
  const storiesGlob = Array.isArray(options.storiesGlob)
    ? options.storiesGlob
    : [options.storiesGlob]

  const ROUTE = "/.figma/make/kit.html"

  const VIRTUAL_ID = "virtual:figma-stories"

  const RESOLVED_ID = "\0" + VIRTUAL_ID

  const STORIES_MODULE = `export const stories = import.meta.glob(${JSON.stringify(storiesGlob)})`

  const HTML_BOOTSTRAP = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body>
<div id="figma-make-kit-root"></div>
<script type="module">
  import { stories } from 'virtual:figma-stories'
  window.__FIGMA__ = Object.assign(window.__FIGMA__ ?? {}, { stories })
  window.dispatchEvent(new CustomEvent('figma.ready'))
</script>
</body>
</html>`

  return {
    name: "figma-make-kit",

    apply: "serve",

    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID

      return null
    },

    load(id) {
      if (id !== RESOLVED_ID) return null

      return STORIES_MODULE
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || ""

        if (url.split("?")[0] !== ROUTE) return next()

        try {
          res.setHeader("Content-Type", "text/html")

          res.end(await server.transformIndexHtml(url, HTML_BOOTSTRAP))
        } catch (err) {
          next(err as Error)
        }
      })
    },
  }
}
