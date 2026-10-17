import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  OAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as signOutFirebase,
  updateProfile,
  type User,
} from "firebase/auth"
import {
  auth as firebaseAuth,
  firebaseConfigured,
} from "./firebase"
import {
  analyzeRepository,
  fetchAccessibleRepositories,
  fetchIssues,
  fetchTextFile,
  inferRelevantFiles,
  parseGitHubUrl,
  sourceFilePaths,
  type GitHubIssue,
  type AccessibleRepository,
  type ProjectAnalysis,
} from "./github"
import {
  getAuthStatus,
  signOutGitHub,
  startGitHubLogin,
  type AuthStatus,
} from "./auth"
import {
  explainWithGroq,
  generateTestWithGroq,
  getAiStatus,
  type AiStatus,
} from "./groq"

type Screen = "landing" | "auth" | "connect" | "dashboard" | "explorer" | "issues" | "tests" | "guide" | "settings"

type WorkspaceContextValue = {
  analysis: ProjectAnalysis | null
  setAnalysis: (analysis: ProjectAnalysis | null) => void
  issues: GitHubIssue[]
  setIssues: (issues: GitHubIssue[]) => void
  selectedIssue: GitHubIssue | null
  setSelectedIssue: (issue: GitHubIssue | null) => void
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

function useWorkspace() {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error("Workspace context is unavailable.")
  return value
}

function renderInlineMarkdown(text: string) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>
    return part
  })
}

function MarkdownAnswer({ content }: { content: string }) {
  const blocks: ReactNode[] = []
  const lines = content.replace(/\r/g, "").split("\n")
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim() || line.trim() === "---") { index += 1; continue }
    if (line.trim().startsWith("```")) {
      const language = line.trim().slice(3).trim()
      const code: string[] = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith("```")) code.push(lines[index++])
      blocks.push(<div className="ai-code-block" key={`code-${index}`}>{language && <span>{language}</span>}<pre><code>{code.join("\n")}</code></pre></div>)
      index += 1
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      const headingContent = renderInlineMarkdown(heading[2])
      const key = `heading-${index}`
      if (heading[1].length === 1) blocks.push(<h2 key={key}>{headingContent}</h2>)
      else if (heading[1].length === 2) blocks.push(<h3 key={key}>{headingContent}</h3>)
      else if (heading[1].length === 3) blocks.push(<h4 key={key}>{headingContent}</h4>)
      else blocks.push(<h5 key={key}>{headingContent}</h5>)
      index += 1
      continue
    }
    const listMatch = line.match(/^\s*(\d+\.|[-*])\s+(.+)$/)
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[1])
      const items: string[] = []
      while (index < lines.length) {
        const item = lines[index].match(/^\s*(\d+\.|[-*])\s+(.+)$/)
        if (!item || /\d+\./.test(item[1]) !== ordered) break
        items.push(item[2]); index += 1
      }
      const children = items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>)
      blocks.push(ordered ? <ol key={`list-${index}`}>{children}</ol> : <ul key={`list-${index}`}>{children}</ul>)
      continue
    }
    const paragraph = [line.trim()]
    index += 1
    while (index < lines.length && lines[index].trim() && !/^(#{1,4})\s+|^\s*(\d+\.|[-*])\s+|^```|^---$/.test(lines[index])) paragraph.push(lines[index++].trim())
    blocks.push(<p key={`paragraph-${index}`}>{renderInlineMarkdown(paragraph.join(" "))}</p>)
  }
  return <div className="ai-generated-answer">{blocks}</div>
}

type IconName = "arrow" | "branch" | "check" | "chevron" | "code" | "command" | "dashboard" | "file" | "folder" | "github" | "guide" | "issue" | "layers" | "menu" | "play" | "plus" | "repo" | "search" | "settings" | "spark" | "test" | "x"

const paths: Record<IconName, ReactNode> = {
  arrow: (
    <>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </>
  ),

  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="6" cy="19" r="2" />
      <path d="M6 7v10M8 7c3 0 3 5 6 5h2" />
    </>
  ),

  check: <path d="m5 12 4 4L19 6" />,

  chevron: <path d="m9 18 6-6-6-6" />,

  code: (
    <>
      <path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14" />
    </>
  ),

  command: (
    <>
      <path d="M9 6V5a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v14a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z" />
    </>
  ),

  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),

  file: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h4" />
    </>
  ),

  folder: <path d="M3 6h7l2 2h9v11H3z" />,

  github: (
    <path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.9c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.6 1.1 1.6 1.1.9 1.6 2.4 1.1 2.9.9.1-.7.4-1.1.7-1.3-2.2-.3-4.6-1.1-4.6-5A3.9 3.9 0 0 1 6.8 8.7a3.6 3.6 0 0 1 .1-2.7s.8-.3 2.8 1A9.6 9.6 0 0 1 12 6.7a9.6 9.6 0 0 1 2.5.3c1.9-1.3 2.8-1 2.8-1a3.6 3.6 0 0 1 .1 2.7 3.9 3.9 0 0 1 1.1 2.8c0 3.9-2.4 4.7-4.6 5 .4.3.7 1 .7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2Z" />
  ),

  guide: (
    <>
      <path d="M5 4h14v16H5z" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>
  ),

  issue: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6M12 17h.01" />
    </>
  ),

  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5z" />
      <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
    </>
  ),

  menu: <path d="M4 7h16M4 12h16M4 17h16" />,

  play: <path d="m8 5 11 7-11 7z" />,

  plus: <path d="M12 5v14M5 12h14" />,

  repo: (
    <>
      <path d="M5 3h12a2 2 0 0 1 2 2v16H7a2 2 0 0 1-2-2z" />
      <path d="M8 3v18M12 7h4" />
    </>
  ),

  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),

  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A8 8 0 0 0 15 6l-.3-2.6h-4L10.3 6a8 8 0 0 0-1.7 1L6.2 6 4.3 9.4l2 1.6a7 7 0 0 0 0 2L4.3 14.6 6.2 18l2.4-1a8 8 0 0 0 1.7 1l.4 2.6h4L15 18a8 8 0 0 0 1.6-1l2.4 1 2-3.4-2.1-1.5a7 7 0 0 0 .1-1Z" />
    </>
  ),

  spark: (
    <>
      <path d="m12 3 1.4 4.4L18 9l-4.6 1.6L12 15l-1.4-4.4L6 9l4.6-1.6z" />
      <path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z" />
    </>
  ),

  test: (
    <>
      <path d="M9 3h6M10 3v5l-5 9a2.7 2.7 0 0 0 2.4 4h9.2a2.7 2.7 0 0 0 2.4-4l-5-9V3" />
      <path d="M7 15h10" />
    </>
  ),

  x: <path d="m6 6 12 12M18 6 6 18" />,
}

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  )
}

function Logo({ onClick }: { onClick?: () => void }) {
  return (
    <button className="logo" onClick={onClick}>
      <span className="logo-mark">
        <span />
      </span>
      <b>DevPilot</b>
    </button>
  )
}

function Button({
  children,
  icon,
  kind = "primary",
  onClick,
  disabled,
}: {
  children: ReactNode
  icon?: IconName
  kind?: "primary" | "secondary" | "tertiary" | "danger"
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button className={`button ${kind}`} onClick={onClick} disabled={disabled}>
      {icon && <Icon name={icon} size={16} />}
      {children}
    </button>
  )
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode
  tone?: "neutral" | "purple" | "green" | "amber" | "red"
}) {
  return <span className={`badge ${tone}`}>{children}</span>
}

function Landing({ go }: { go: (s: Screen) => void }) {
  const [quickUrl, setQuickUrl] = useState("")
  const openImport = () => {
    if (quickUrl) sessionStorage.setItem("devpilot:repo-url", quickUrl)
    go("connect")
  }
  const scrollTo = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" })
  return (
    <main className="landing">
      <nav className="marketing-nav">
        <Logo onClick={() => go("landing")} />
        <div className="nav-links">
          <button onClick={() => scrollTo("product")}>Product</button>
          <button onClick={() => scrollTo("workflow")}>How it works</button>
          <button onClick={() => scrollTo("features")}>Features</button>
        </div>
        <div className="nav-actions">
          <Button kind="tertiary" onClick={() => go("auth")}>Sign in</Button>
          <Button onClick={() => go("connect")}>Get Started</Button>
        </div>
      </nav>
      <section className="hero">
        <Badge tone="purple">YOUR FIRST CONTRIBUTION STARTS HERE</Badge>
        <h1>
          From unfamiliar code to
          <br />
          your first contribution.
        </h1>
        <p>
          Understand codebases, investigate issues, and validate changes with an
          AI guide that helps you learn as you contribute.
        </p>
        <div className="hero-actions">
          <Button onClick={() => go("connect")} icon="arrow">
            Explore a Repository
          </Button>
          <Button
            kind="secondary"
            icon="play"
            onClick={() => scrollTo("workflow")}
          >
            See How It Works
          </Button>
        </div>
        <form
          className="repo-entry"
          onSubmit={(e) => {
            e.preventDefault()
            openImport()
          }}
        >
          <Icon name="github" />
          <input
            value={quickUrl}
            onChange={(e) => setQuickUrl(e.target.value)}
            placeholder="Paste a public GitHub repository URL…"
          />
          <Button disabled={!parseGitHubUrl(quickUrl)}>
            Analyze repository
          </Button>
        </form>
      </section>
      <section className="product-preview" id="product">
        <div className="preview-bar">
          <div className="window-dots">
            <i />
            <i />
            <i />
          </div>
          <span>
            <Icon name="repo" size={14} /> opensource-labs / compass
          </span>
          <Badge tone="green">Analysis complete</Badge>
        </div>
        <div className="preview-grid">
          <div className="mini-tree">
            <b>PROJECT</b>
            {["src", "components", "api", "router.ts", "index.ts"].map(
              (x, i) => (
                <div className={i === 3 ? "active" : ""} key={x}>
                  <Icon name={i < 3 ? "folder" : "file"} size={14} />
                  {x}
                </div>
              ),
            )}
          </div>
          <div className="mini-code">
            <div className="tab">
              router.ts <span>×</span>
            </div>
            <CodeLines short />
          </div>
          <div className="mini-ai">
            <Badge tone="purple">
              <Icon name="spark" size={12} /> SOURCE-BACKED
            </Badge>
            <h3>Route handler overview</h3>
            <p>
              This module registers API routes and applies authentication
              middleware before each request.
            </p>
            <div className="evidence">3 references found</div>
          </div>
        </div>
      </section>
      <section className="features" id="features">
        <div className="section-intro">
          <Badge tone="purple">BUILT FOR LEARNING IN CONTEXT</Badge>
          <h2>Everything you need to make a confident change</h2>
        </div>
        <div className="feature-grid">
          {[
            [
              "layers",
              "Understand the Codebase",
              "See how modules connect before reading every file.",
            ],

            [
              "issue",
              "Trace an Issue",
              "Move from symptoms to relevant code with cited evidence.",
            ],

            [
              "test",
              "Generate Tests",
              "Turn expected behavior into a clear, reviewable test.",
            ],

            [
              "check",
              "Verify Changes",
              "Keep proposed work separate from verified results.",
            ],
          ].map(([icon, title, text], i) => (
            <article key={title}>
              <span className={`feature-icon f${i}`}>
                <Icon name={icon as IconName} />
              </span>
              <h3>{title}</h3>
              <p>{text}</p>
              <button>
                Learn more <Icon name="arrow" size={14} />
              </button>
            </article>
          ))}
        </div>
      </section>
      <section className="workflow" id="workflow">
        <p>YOUR CONTRIBUTION PATH</p>
        <h2>A clear path through unfamiliar code</h2>
        <div>
          {[
            "Connect a repository",
            "Understand the architecture",
            "Investigate & verify",
            "Prepare your contribution",
          ].map((x, i) => (
            <article key={x}>
              <span>0{i + 1}</span>
              <h3>{x}</h3>
              <p>
                {
                  [
                    "Start with any public GitHub repository.",
                    "Map modules, dependencies, and flows.",
                    "Trace an issue and run focused tests.",
                    "Review evidence and draft your pull request.",
                  ][i]
                }
              </p>
            </article>
          ))}
        </div>
      </section>
      <section className="final-cta">
        <h2>Make your first contribution with confidence.</h2>
        <p>Understand the code. Investigate the issue. Verify the change.</p>
        <Button onClick={() => go("connect")} icon="arrow">
          Connect a Repository
        </Button>
      </section>
      <footer>
        <Logo onClick={() => go("landing")} />
        <span>Built for open-source learners.</span>
        <span>© 2025 DevPilot</span>
      </footer>
    </main>
  )
}

function Auth({ go }: { go: (s: Screen) => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const showAuthError = (reason: unknown) => {
    const code = typeof reason === "object" && reason !== null && "code" in reason
      ? String(reason.code)
      : "";
    const messages: Record<string, string> = {
      "auth/invalid-credential": "That email and password combination was not recognized.",
      "auth/email-already-in-use": "An account already exists for this email. Sign in instead.",
      "auth/weak-password": "Choose a password with at least 6 characters.",
      "auth/invalid-email": "Enter a valid email address.",
      "auth/popup-closed-by-user": "The provider sign-in window was closed before it finished.",
      "auth/popup-blocked": "Your browser blocked the sign-in window. Allow popups and try again.",
      "auth/operation-not-allowed": "This sign-in method is not enabled in the Firebase Console.",
      "auth/unauthorized-domain": "This site isn't authorized for Firebase sign-in. Add its hostname under Firebase Console > Authentication > Settings > Authorized domains.",
      "auth/account-exists-with-different-credential": "An account already exists for this email with a different sign-in method. Sign in with that method instead.",
      "auth/network-request-failed": "Couldn't reach Firebase. Check your internet connection and try again.",
    };
    setError(messages[code] ?? "We couldn't complete sign-in. Check your details and try again.");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!firebaseAuth) return;
    setBusy(true);
    setError("");
    try {
      if (mode === "signup") {
        const credential = await createUserWithEmailAndPassword(firebaseAuth, email, password);
        if (name.trim()) await updateProfile(credential.user, { displayName: name.trim() });
      } else {
        await signInWithEmailAndPassword(firebaseAuth, email, password);
      }
    } catch (reason) {
      showAuthError(reason);
    } finally {
      setBusy(false);
    }
  };

  const signInWithGoogle = async () => {
    if (!firebaseAuth) return;
    setBusy(true);
    setError("");
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(firebaseAuth, provider);
    } catch (reason) {
      showAuthError(reason);
    } finally {
      setBusy(false);
    }
  };

  const signInWithGitHub = async () => {
    if (!firebaseAuth) return;
    setBusy(true);
    setError("");
    try {
      const provider = new OAuthProvider("github.com");
      provider.addScope("user:email");
      await signInWithPopup(firebaseAuth, provider);
    } catch (reason) {
      showAuthError(reason);
    } finally {
      setBusy(false);
    }
  };

  return <div className="auth-page">
    <header><Logo onClick={() => go("landing")} /><button onClick={() => go("landing")}>Back to DevPilot</button></header>
    <main>
      <div className="auth-heading"><Badge tone="purple">YOUR DEVPILOT WORKSPACE</Badge><h1>{mode === "signup" ? "Create your account" : "Welcome back"}</h1><p>{mode === "signup" ? "Create an account to start exploring repositories." : "Sign in to continue to your workspace."}</p></div>
      <section className="auth-card">
        <div className="auth-providers">
          <button className="provider-auth" onClick={signInWithGoogle} disabled={busy || !firebaseConfigured}><span className="google-mark">G</span>{mode === "signup" ? "Sign up with Google" : "Continue with Google"}</button>
          <button className="provider-auth" onClick={signInWithGitHub} disabled={busy || !firebaseConfigured}><Icon name="github" size={16} />{mode === "signup" ? "Sign up with GitHub" : "Continue with GitHub"}</button>
        </div>
        <div className="auth-divider"><span>or continue with email</span></div>
        <form className="auth-form" onSubmit={submit}>
          {mode === "signup" && <label>Name<input autoComplete="name" value={name} onChange={event => setName(event.target.value)} required /></label>}
          <label>Email address<input type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} required /></label>
          <label>Password<input type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={6} value={password} onChange={event => setPassword(event.target.value)} required /></label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          {!firebaseConfigured && <p className="auth-config-note">Firebase isn't configured yet. Add the web app values from your Firebase project to `.env.local`, then restart the dev server.</p>}
          <button className="button primary auth-submit" type="submit" disabled={busy || !firebaseConfigured}>{busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}</button>
        </form>
        <p className="auth-switch">{mode === "signup" ? "Already have an account?" : "New to DevPilot?"} <button onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(""); }}>{mode === "signup" ? "Sign in" : "Create an account"}</button></p>
      </section>
      <button className="auth-back" onClick={() => go("landing")}>Return to the homepage</button>
    </main>
  </div>;
}

const navItems: [Screen, IconName, string][] = [
  ["dashboard", "dashboard", "Overview"],
  ["dashboard", "repo", "My Repositories"],
  ["explorer", "code", "Codebase Explorer"],

  ["issues", "issue", "Issues & Tasks"],
  ["tests", "test", "Test Lab"],
  ["guide", "guide", "Contribution Guide"],
]

function Shell({
  screen,
  go,
  children,
}: {
  screen: Screen
  go: (s: Screen) => void
  children: ReactNode
}) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const { analysis } = useWorkspace()
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  useEffect(() => {
    getAuthStatus().then(setAuth).catch(() => setAuth(null))
  }, [])
  const initials = (auth?.user?.name || auth?.user?.login || "GH")
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
  return (
    <div className="app-shell">
      <aside className={mobileOpen ? "sidebar open" : "sidebar"}>
        <div className="side-head">
          <Logo onClick={() => go("landing")} />
          <button className="mobile-close" onClick={() => setMobileOpen(false)}>
            <Icon name="x" />
          </button>
        </div>
        <Button onClick={() => go("connect")} kind="secondary" icon="plus">
          Add repository
        </Button>
        <div className="nav-label">WORKSPACE</div>
        <nav className="side-nav">
          {navItems.map(([id, icon, label], i) => (
            <button
              key={`${label}-${i}`}
              className={
                screen === id && (id !== "dashboard" || i === 0) ? "active" : ""
              }
              onClick={() => {
                go(id)
                setMobileOpen(false)
              }}
            >
              <Icon name={icon} />
              {label}
              {label === "Issues & Tasks" && <span>3</span>}
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <button>
            <Icon name="guide" />
            Documentation
          </button>
          <button
            onClick={() => go("settings")}
            className={screen === "settings" ? "active" : ""}
          >
            <Icon name="settings" />
            Settings
          </button>
          <div className="profile">
            <span>{initials}</span>
            <div>
              <b>{auth?.user?.name ?? "GitHub user"}</b>
              <small>@{auth?.user?.login ?? "authenticated"}</small>
            </div>
            <Icon name="chevron" size={14} />
          </div>
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileOpen(true)}>
            <Icon name="menu" />
          </button>
          <div className="repo-switcher">
            <Icon name="repo" />
            <b>{analysis?.repo.fullName ?? "No repository connected"}</b>
            <Icon name="chevron" size={13} />
          </div>
          <div className="top-actions">
            <button className="global-search" onClick={() => go("explorer")}>
              <Icon name="search" size={15} />
              <span>Search repository</span>
              <kbd>⌘ K</kbd>
            </button>
            <button className="icon-button" onClick={() => go("explorer")}>
              <Icon name="command" />
            </button>
            <span className="avatar">{initials}</span>
          </div>
        </header>
        {children}
      </section>
    </div>
  )
}

function Connect({ go }: { go: (s: Screen) => void }) {
  const { analysis, setAnalysis, setIssues } = useWorkspace()
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [repositories, setRepositories] = useState<AccessibleRepository[]>([])
  const [authError, setAuthError] = useState("")
  const [stage, setStage] = useState<"form" | "analyzing" | "done" | "error">(
    analysis ? "done" : "form",
  )
  const [repoUrl, setRepoUrl] = useState(
    analysis?.repo.htmlUrl ?? sessionStorage.getItem("devpilot:repo-url") ?? "",
  )
  const [error, setError] = useState("")
  const [progress, setProgress] = useState(0)
  const validRepo = parseGitHubUrl(repoUrl) !== null
  useEffect(() => {
    getAuthStatus()
      .then(async (status) => {
        setAuth(status)
        if (status.authenticated) {
          setRepositories(await fetchAccessibleRepositories())
        }
      })
      .catch((reason) =>
        setAuthError(
          reason instanceof Error
            ? reason.message
            : "Unable to check GitHub authentication.",
        ),
      )
  }, [])
  const connect = async () => {
    if (!validRepo || !auth?.authenticated) return
    setStage("analyzing")
    setError("")
    setProgress(1)
    try {
      const next = await analyzeRepository(repoUrl)
      setProgress(4)
      setAnalysis(next)
      try {
        setIssues(await fetchIssues(next.repo.owner, next.repo.name))
      } catch {
        setIssues([])
      }
      setProgress(5)
      setStage("done")
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Repository analysis failed.",
      )
      setStage("error")
    }
  }
  const steps = [
    "Repository metadata loaded",
    "Complete file tree indexed",
    "Languages and frameworks detected",
    "Dependencies and entry points mapped",
    "Issues and explorer prepared",
  ]
  return (
    <div className="connect-page">
      <header>
        <Logo onClick={() => go("landing")} />
        <div className="connect-header-actions">
          <Badge tone="green">LIVE GITHUB DATA</Badge>
          <button className="connect-back" onClick={() => go("landing")}>
            <Icon name="arrow" size={15} />
            Back to home
          </button>
        </div>
      </header>
      <main>
        <div className="stepper">
          <span className="on">1</span>
          <i />
          <span className={stage !== "form" ? "on" : ""}>2</span>
          <i />
          <span className={stage === "done" ? "on" : ""}>3</span>
        </div>
        {!auth?.authenticated ? (
          <div className="connect-card auth-gate">
            <span className="auth-mark">
              <Icon name="github" size={28} />
            </span>
            <Badge tone="purple">GITHUB CONNECTION REQUIRED</Badge>
            <h1>Connect GitHub to access repositories</h1>
            <p>
              Your DevPilot account is separate from GitHub. Authorize GitHub
              here so DevPilot can read repositories you can access and use
              your authenticated API allowance for repository analysis.
            </p>
            <div className="permission-list">
              <div>
                <Icon name="check" size={15} />
                <span>
                  <b>Read your GitHub profile</b>
                  <small>Identifies the GitHub account connected for repositories</small>
                </span>
              </div>
              <div>
                <Icon name="check" size={15} />
                <span>
                  <b>Read repositories you authorize</b>
                  <small>Required for source, issues, and private repositories</small>
                </span>
              </div>
              <div>
                <Icon name="check" size={15} />
                <span>
                  <b>Server-side token storage</b>
                  <small>The access token is never exposed to browser code</small>
                </span>
              </div>
            </div>
            {authError && <div className="inline-error">{authError}</div>}
            {!auth && !authError ? (
              <div className="auth-checking">
                <i className="spinner" /> Checking authentication…
              </div>
            ) : (
              <Button
                onClick={startGitHubLogin}
                disabled={!auth?.configured}
                icon="github"
              >
                Authorize GitHub
              </Button>
            )}
            {auth && !auth.configured && (
              <p className="auth-config-note">
                The server administrator must configure GITHUB_CLIENT_ID and
                GITHUB_CLIENT_SECRET before sign-in can begin.
              </p>
            )}
            <small className="auth-footnote">
              GitHub will show the requested permissions before you approve
              access. You can revoke access from GitHub settings at any time.
            </small>
          </div>
        ) : stage === "form" ? (
          <div className="connect-card">
            <Badge tone="purple">
              <Icon name="repo" size={12} /> AUTHORIZED REPOSITORY ACCESS
            </Badge>
            <h1>Choose a repository to analyze</h1>
            <p>
              Signed in as <b>@{auth.user?.login}</b>. DevPilot makes
              authenticated, read-only GitHub requests through the server.
            </p>
            {repositories.length > 0 && (
              <div className="authorized-repos">
                <label>Your recently updated repositories</label>
                <div>
                  {repositories.slice(0, 6).map((repo) => (
                    <button
                      key={repo.fullName}
                      className={repoUrl === repo.htmlUrl ? "active" : ""}
                      onClick={() => setRepoUrl(repo.htmlUrl)}
                    >
                      <Icon name={repo.private ? "repo" : "github"} size={15} />
                      <span>
                        <b>{repo.fullName}</b>
                        <small>{repo.description}</small>
                      </span>
                      <Badge tone={repo.private ? "amber" : "green"}>
                        {repo.private ? "PRIVATE" : "PUBLIC"}
                      </Badge>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <label>Repository URL</label>
            <div className={`field ${repoUrl && !validRepo ? "invalid" : ""}`}>
              <Icon name="github" />
              <input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && connect()}
                placeholder="https://github.com/owner/repository"
              />
              <button type="button">
                {validRepo ? "URL valid" : "Check URL"}
              </button>
            </div>
            {repoUrl && !validRepo && (
              <p className="field-error">
                Enter a GitHub repository URL available to your account.
              </p>
            )}
            <div
              className={`repo-preview ${validRepo ? "" : "disabled-preview"}`}
            >
              <span className="repo-avatar">GH</span>
              <div>
                <b>
                  {validRepo
                    ? repoUrl
                        .replace(/^https:\/\/github\.com\//, "")
                        .replace("/", " / ")
                    : "Repository preview"}
                </b>
                <p>
                  {validRepo
                    ? "Authenticated GitHub access will be used"
                    : "Waiting for a valid repository URL"}
                </p>
                <div>
                  <Badge tone="green">Live data</Badge>
                  <span>Public and authorized private repositories</span>
                </div>
              </div>
              {validRepo && <Icon name="check" />}
            </div>
            <Button disabled={!validRepo} onClick={connect} icon="arrow">
              Analyze Repository
            </Button>
            <div className="permission authenticated-permission">
              <Icon name="github" />
              <div>
                <b>Authenticated as @{auth.user?.login}</b>
                <p>API requests use your GitHub session and higher rate limit.</p>
              </div>
              <Badge tone="green">CONNECTED</Badge>
            </div>
          </div>
        ) : (
          <div className="connect-card analysis">
            <div
              className={
                stage === "done" ? "analysis-ring done" : "analysis-ring"
              }
            >
              <Icon
                name={
                  stage === "done" ? "check" : stage === "error" ? "x" : "spark"
                }
                size={28}
              />
            </div>
            <h1>
              {stage === "done"
                ? "Repository ready"
                : stage === "error"
                  ? "Analysis could not complete"
                  : "Reading repository data"}
            </h1>
            <p>
              {stage === "done"
                ? `${analysis?.repo.fullName} is indexed from GitHub.`
                : stage === "error"
                  ? error
                  : "Fetching metadata, the Git tree, manifests, languages, and issues."}
            </p>
            <Badge
              tone={
                stage === "error" ? "red" : stage === "done" ? "green" : "amber"
              }
            >
              {stage === "error"
                ? "GITHUB ERROR"
                : stage === "done"
                  ? "LIVE ANALYSIS COMPLETE"
                  : "LIVE ANALYSIS"}
            </Badge>
            <div className="analysis-list">
              {steps.map((x, i) => (
                <div key={x} className={i < progress ? "complete" : ""}>
                  <span>
                    {i < progress ? (
                      <Icon name="check" size={14} />
                    ) : i === progress && stage === "analyzing" ? (
                      <i className="spinner" />
                    ) : (
                      <i />
                    )}
                  </span>
                  <b>{x}</b>
                  <small>
                    {i < progress
                      ? "Complete"
                      : i === progress && stage === "analyzing"
                        ? "In progress"
                        : "Waiting"}
                  </small>
                </div>
              ))}
            </div>
            {stage === "done" && (
              <Button onClick={() => go("dashboard")} icon="arrow">
                Open live workspace
              </Button>
            )}
            {stage === "error" && (
              <Button onClick={() => setStage("form")} kind="secondary">
                Try another repository
              </Button>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

function Dashboard({ go }: { go: (s: Screen) => void }) {
  const [refreshing, setRefreshing] = useState(false)
  const [updated, setUpdated] = useState("12 min ago")
  const refresh = () => {
    setRefreshing(true)
    window.setTimeout(() => {
      setRefreshing(false)
      setUpdated("just now")
    }, 1100)
  }
  return (
    <div className="page dashboard-page">
      <div className="page-title">
        <div>
          <p>WORKSPACE OVERVIEW</p>
          <h1>Welcome back, Alex</h1>
          <span>
            Pick up where you left off, or explore your next contribution.
          </span>
        </div>
        <div className="title-actions">
          <Button
            kind="secondary"
            onClick={refreshing ? undefined : refresh}
            icon="command"
          >
            {refreshing ? "Refreshing…" : "Refresh index"}
          </Button>
          <Button onClick={() => go("connect")} icon="plus">
            Add Repository
          </Button>
        </div>
      </div>
      <section className="repo-overview panel">
        <div className="repo-identity">
          <span className="repo-avatar">C</span>
          <div>
            <div className="eyebrow">ACTIVE REPOSITORY</div>
            <h2>opensource-labs / compass</h2>
            <p>Developer-first API toolkit for TypeScript</p>
          </div>
        </div>
        <div className="overview-facts">
          <div>
            <span>Default branch</span>
            <b>
              <Icon name="branch" size={13} /> main
            </b>
          </div>
          <div>
            <span>Analysis</span>
            <b className={refreshing ? "is-refreshing" : "healthy"}>
              {refreshing ? "Indexing…" : "Complete"}
            </b>
          </div>
          <div>
            <span>Source files</span>
            <b>148</b>
          </div>
          <div>
            <span>Available tests</span>
            <b>36 · Vitest</b>
          </div>
          <div>
            <span>Last indexed</span>
            <b>{updated}</b>
          </div>
        </div>
        <div className="tech-row">
          <span>Detected stack</span>
          <Badge tone="purple">TypeScript</Badge>
          <Badge tone="neutral">React</Badge>
          <Badge tone="neutral">Node.js</Badge>
          <Badge tone="neutral">Vitest</Badge>
          <button onClick={() => go("explorer")}>
            Open architecture <Icon name="arrow" size={13} />
          </button>
        </div>
      </section>
      <div className="dashboard-grid">
        <section className="panel recent">
          <div className="panel-head">
            <div>
              <h2>Recently analyzed</h2>
              <p>Your active repositories</p>
            </div>
            <button>View all</button>
          </div>
          <article className="repo-card" onClick={() => go("explorer")}>
            <div className="repo-card-top">
              <span className="repo-avatar">C</span>
              <div>
                <h3>opensource-labs/compass</h3>
                <p>Developer-first API toolkit</p>
              </div>
              <Icon name="arrow" />
            </div>
            <div className="repo-meta">
              <span>
                <i className="lang-dot" />
                TypeScript
              </span>
              <Badge tone="green">Analysis complete</Badge>
              <span>12 min ago</span>
            </div>
            <div className="progress-label">
              <span>Contribution progress</span>
              <b>62%</b>
            </div>
            <div className="progress">
              <i style={{ width: "62%" }} />
            </div>
            <div className="repo-next">
              <Icon name="issue" />
              <span>
                <b>Next: Investigate issue #184</b>
                <small>Request timeout not respected</small>
              </span>
              <Icon name="chevron" />
            </div>
          </article>
        </section>
        <section className="panel contribution">
          <div className="panel-head">
            <div>
              <h2>Contribution path</h2>
              <p>Your progress on #184</p>
            </div>
            <span>5 of 10</span>
          </div>
          {[
            "Understand issue",
            "Identify relevant files",
            "Reproduce behavior",
            "Generate focused test",
            "Verify test result",
          ].map((x, i) => (
            <div className="progress-step" key={x}>
              <span className={i < 3 ? "complete" : i === 3 ? "current" : ""}>
                {i < 3 ? <Icon name="check" size={13} /> : i + 1}
              </span>
              <div>
                <b>{x}</b>
                <small>
                  {i < 3 ? "Completed" : i === 3 ? "Up next" : "Not started"}
                </small>
              </div>
              {i === 3 && <button onClick={() => go("tests")}>Continue</button>}
            </div>
          ))}
        </section>
      </div>
      <div className="dashboard-grid lower">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Recent activity</h2>
              <p>Changes across your workspace</p>
            </div>
          </div>
          {[
            ["code", "Viewed request.ts", "2 minutes ago"],
            ["spark", "Explained retryRequest()", "18 minutes ago"],
            ["issue", "Added issue #184 to contribution path", "Yesterday"],
          ].map(([ic, a, b]) => (
            <div className="activity" key={a}>
              <span>
                <Icon name={ic as IconName} />
              </span>
              <div>
                <b>{a}</b>
                <small>{b}</small>
              </div>
            </div>
          ))}
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Suggested next steps</h2>
              <p>Based on your recent work</p>
            </div>
          </div>
          <div className="suggestion">
            <span>
              <Icon name="test" />
            </span>
            <div>
              <Badge tone="purple">RECOMMENDED</Badge>
              <h3>Write a focused regression test</h3>
              <p>
                You’ve found the likely timeout path. Generate a test before
                proposing a change.
              </p>
              <Button kind="secondary" onClick={() => go("tests")}>
                Open Test Lab
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

const files = [
  ["folder", "src"],
  ["folder", "  core"],
  ["file", "    client.ts"],
  ["file", "    request.ts"],
  ["folder", "  middleware"],
  ["file", "    timeout.ts"],
  ["file", "    retry.ts"],
  ["folder", "tests"],
  ["file", "  request.test.ts"],
  ["file", "package.json"],
]

function CodeLines({ short = false }: { short?: boolean }) {
  const lines = [
    ["1", "import { TimeoutError } from './errors';"],

    ["2", "import type { RequestConfig } from './types';"],

    ["3", ""],

    ["4", "export async function request("],

    ["5", "  url: string, config: RequestConfig"],

    ["6", ") {"],

    ["7", "  const controller = new AbortController();"],

    ["8", "  const timeout = config.timeout ?? 5000;"],

    ["9", ""],

    ["10", "  const timer = setTimeout(() => {"],

    ["11", "    controller.abort();"],

    ["12", "  }, timeout);"],

    ["13", ""],

    ["14", "  try {"],

    ["15", "    return await fetch(url, {"],

    ["16", "      ...config,"],

    ["17", "      signal: controller.signal,"],

    ["18", "    });"],

    ["19", "  } catch (error) {"],

    ["20", "    if (controller.signal.aborted) {"],

    ["21", "      throw new TimeoutError(url, timeout);"],

    ["22", "    }"],

    ["23", "    throw error;"],

    ["24", "  } finally {"],

    ["25", "    clearTimeout(timer);"],

    ["26", "  }"],

    ["27", "}"],
  ]

  return (
    <pre className="code-lines">
      {lines.slice(0, short ? 12 : undefined).map(([n, c]) => (
        <div
          key={n}
          className={
            !short && Number(n) >= 10 && Number(n) <= 12 ? "selected" : ""
          }
        >
          <span>{n}</span>
          <code>{highlight(c)}</code>
        </div>
      ))}
    </pre>
  )
}

function highlight(s: string) {
  const parts = s.split(
    /(\b(?:import|from|type|export|async|function|const|new|try|return|await|catch|if|throw|finally)\b|'[^']*'|\b\d+\b)/g,
  )

  return (
    <>
      {parts.map((x, i) => (
        <span
          key={i}
          className={
            /^(import|from|type|export|async|function|const|new|try|return|await|catch|if|throw|finally)$/.test(
              x,
            )
              ? "kw"
              : /^'/.test(x)
                ? "str"
                : /^\d+$/.test(x)
                  ? "num"
                  : ""
          }
        >
          {x}
        </span>
      ))}
    </>
  )
}

function Explorer({ go }: { go: (s: Screen) => void }) {
  const [mode, setMode] = useState<"code" | "graph">("code")
  const [selected, setSelected] = useState("    request.ts")
  const [query, setQuery] = useState("")
  const [level, setLevel] = useState<"Beginner" | "Intermediate" | "Advanced">(
    "Beginner",
  )
  const [explanation, setExplanation] = useState("Explain File")
  const visibleFiles = files.filter(([, name]) =>
    name.trim().toLowerCase().includes(query.toLowerCase()),
  )
  return (
    <div className="explorer">
      <div className="explorer-toolbar">
        <div className="breadcrumbs">
          <span>opensource-labs</span>
          <Icon name="chevron" size={12} />
          <b>compass</b>
          <Badge tone="neutral">
            <Icon name="branch" size={12} />
            main
          </Badge>
        </div>
        <div className="view-tabs">
          <button
            className={mode === "code" ? "active" : ""}
            onClick={() => setMode("code")}
          >
            <Icon name="code" size={15} />
            Code
          </button>
          <button
            className={mode === "graph" ? "active" : ""}
            onClick={() => setMode("graph")}
          >
            <Icon name="layers" size={15} />
            Architecture
          </button>
        </div>
        <div className="tool-buttons">
          <button>
            <Icon name="search" />
            Search
          </button>
          <button>
            <Icon name="command" />
            Commands
          </button>
        </div>
      </div>
      <div className="explorer-grid">
        <aside className="file-panel">
          <div className="panel-title">
            <b>EXPLORER</b>
            <span>{visibleFiles.length} items</span>
          </div>
          <label className="file-search">
            <Icon name="search" size={14} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search files"
            />
          </label>
          <div className="tree-title">
            <Icon name="chevron" size={12} />
            <b>COMPASS</b>
          </div>
          {visibleFiles.map(([type, name], i) => (
            <button
              key={`${name}-${i}`}
              className={selected === name ? "selected" : ""}
              onClick={() => setSelected(name)}
            >
              <span
                className="indent"
                style={{
                  width: `${(name.length - name.trimStart().length) * 5}px`,
                }}
              />
              <Icon name={type as IconName} size={14} />
              <span>{name.trim()}</span>
              {name.includes("request") && <i title="Relevant to issue #184" />}
            </button>
          ))}
          {visibleFiles.length === 0 && (
            <p className="empty-inline">No files match “{query}”.</p>
          )}
          <div className="recent-label">RECENTLY VIEWED</div>
          <button onClick={() => setSelected("types.ts")}>
            <Icon name="file" size={14} />
            <span>types.ts</span>
          </button>
          <button onClick={() => setSelected("errors.ts")}>
            <Icon name="file" size={14} />
            <span>errors.ts</span>
          </button>
        </aside>
        <section className="editor">
          {mode === "code" ? (
            <>
              <div className="editor-tabs">
                <div>
                  <Icon name="file" size={14} />
                  {selected.trim()}
                  <span>×</span>
                </div>
              </div>
              <div className="editor-bar">
                <div>
                  <span>src</span>
                  <Icon name="chevron" size={11} />
                  <span>core</span>
                  <Icon name="chevron" size={11} />
                  <b>{selected.trim()}</b>
                </div>
                <div>
                  <button>Ln 10–12</button>
                  <button>Copy</button>
                  <button>
                    <Icon name="search" size={14} />
                  </button>
                </div>
              </div>
              <CodeLines />
            </>
          ) : (
            <Architecture />
          )}
        </section>
        <aside className="ai-panel">
          <div className="ai-head">
            <span>
              <Icon name="spark" />
              Understand this file
            </span>
            <div className="level-switch">
              {(["Beginner", "Intermediate", "Advanced"] as const).map((x) => (
                <button
                  key={x}
                  className={level === x ? "active" : ""}
                  onClick={() => setLevel(x)}
                >
                  {x[0]}
                </button>
              ))}
            </div>
          </div>
          <div className="ai-scroll">
            <div className="quick-actions">
              {[
                "Explain File",
                "Explain Function",
                "Show Dependencies",
                "Trace Execution Flow",
                "Find Related Tests",
              ].map((x) => (
                <button
                  className={explanation === x ? "active" : ""}
                  onClick={() => setExplanation(x)}
                  key={x}
                >
                  {x}
                  <Icon name="arrow" size={13} />
                </button>
              ))}
            </div>
            <div className="answer">
              <div className="answer-head">
                <span className="ai-avatar">
                  <Icon name="spark" size={15} />
                </span>
                <div>
                  <b>
                    {explanation}: {selected.trim()}
                  </b>
                  <small>{level} level · based on 4 source references</small>
                </div>
              </div>
              <p>
                {explanation === "Show Dependencies"
                  ? "This module depends on request configuration and timeout error types, and is called by the API client before retry middleware runs."
                  : explanation === "Trace Execution Flow"
                    ? "A client call creates the abort controller, starts the configured timer, calls fetch, then clears the timer in finally. Retry middleware may invoke the flow again."
                    : explanation === "Find Related Tests"
                      ? "The closest coverage is in tests/request.test.ts. Issue #184 still needs a focused retry timeout regression test."
                      : "This file wraps the native fetch API with timeout handling. The selected lines create a timer that aborts the request after the configured duration."}
              </p>
              <div className="evidence-card">
                <Badge tone="green">CONFIRMED EVIDENCE</Badge>
                <p>
                  <b>src/core/request.ts:10–12</b>
                  <br />
                  The abort timer uses <code>config.timeout</code>, falling back
                  to 5000ms.
                </p>
                <button onClick={() => setSelected("    request.ts")}>
                  Open reference <Icon name="arrow" size={12} />
                </button>
              </div>
              <div className="hypothesis-card">
                <Badge tone="amber">SUSPECTED CAUSE</Badge>
                <p>
                  Retry middleware may recreate the request without forwarding
                  its original timeout.
                </p>
              </div>
            </div>
            <div className="learning-path">
              <b>Recommended learning path</b>
              <ol>
                <li>src/core/client.ts · public API</li>
                <li>src/core/request.ts · request lifecycle</li>
                <li>src/middleware/retry.ts · issue path</li>
                <li>tests/request.test.ts · existing coverage</li>
              </ol>
            </div>
          </div>
          <form
            className="ask-box"
            onSubmit={(e) => {
              e.preventDefault()
              setExplanation("Explain Function")
            }}
          >
            <input placeholder={`Ask about ${selected.trim()}…`} />
            <button aria-label="Ask">
              <Icon name="arrow" size={15} />
            </button>
            <small>AI can make mistakes. Verify source references.</small>
          </form>
        </aside>
      </div>
      <div className="mobile-screen-nav">
        <button onClick={() => go("issues")}>
          <Icon name="issue" />
          Investigate issue #184
        </button>
      </div>
    </div>
  )
}

function Architecture() {
  return (
    <div className="architecture">
      <div className="arch-head">
        <div>
          <h2>Architecture map</h2>
          <p>Explore how modules connect across the repository.</p>
        </div>
        <Badge tone="green">12 modules mapped</Badge>
      </div>
      <div className="graph">
        <svg viewBox="0 0 700 470">
          <g className="edges">
            <path d="M350 88 185 190M350 88l160 102M185 230l80 98M510 230l-80 98M350 120v200" />
          </g>
        </svg>
        <button className="node root">
          <Icon name="layers" />
          <b>API Client</b>
          <small>src/core/client.ts</small>
        </button>
        <button className="node n1">
          <Icon name="code" />
          <b>Request</b>
          <small>src/core/request.ts</small>
        </button>
        <button className="node n2">
          <Icon name="code" />
          <b>Middleware</b>
          <small>src/middleware</small>
        </button>
        <button className="node n3">
          <Icon name="test" />
          <b>Request tests</b>
          <small>tests/request.test.ts</small>
        </button>
        <button className="node n4">
          <Icon name="issue" />
          <b>Error types</b>
          <small>src/core/errors.ts</small>
        </button>
      </div>
    </div>
  )
}

function Issues({ go }: { go: (s: Screen) => void }) {
  const issues = [
    {
      id: "184",
      title: "Request timeout not respected",
      label: "bug",
      age: "2h",
    },
    {
      id: "179",
      title: "Headers lost after redirect",
      label: "bug",
      age: "1d",
    },
    {
      id: "166",
      title: "Add streaming response support",
      label: "enhancement",
      age: "4d",
    },
  ]
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState("184")
  const [syncing, setSyncing] = useState(false)
  const current = issues.find((x) => x.id === selected) ?? issues[0]
  const filtered = issues.filter((x) =>
    `${x.id} ${x.title} ${x.label}`.toLowerCase().includes(query.toLowerCase()),
  )
  const sync = () => {
    setSyncing(true)
    window.setTimeout(() => setSyncing(false), 900)
  }
  return (
    <div className="page issue-page">
      <div className="page-title compact">
        <div>
          <p>ISSUES & TASKS</p>
          <h1>Investigate an issue</h1>
          <span>Trace reported behavior to source-backed evidence.</span>
        </div>
        <Button kind="secondary" onClick={sync} disabled={syncing}>
          {syncing ? "Syncing…" : "Sync issues"}
        </Button>
      </div>
      <div className="issue-layout">
        <aside className="issues-list">
          <label className="file-search">
            <Icon name="search" size={14} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles or labels"
            />
          </label>
          <div className="filter-row">
            <button>
              Open <Icon name="chevron" size={12} />
            </button>
            <button>
              All labels <Icon name="chevron" size={12} />
            </button>
          </div>
          {filtered.map((x) => (
            <button
              className={selected === x.id ? "active" : ""}
              onClick={() => setSelected(x.id)}
              key={x.id}
            >
              <div>
                <span>#{x.id}</span>
                <small>{x.age}</small>
              </div>
              <b>{x.title}</b>
              <Badge tone={x.label === "bug" ? "red" : "purple"}>
                {x.label}
              </Badge>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="empty-inline">No matching issues.</p>
          )}
        </aside>
        <main className="issue-detail">
          <div className="issue-heading">
            <div>
              <span>#{current.id} · Open</span>
              <h2>
                {current.id === "184"
                  ? "Request timeout is not respected after retry"
                  : current.title}
              </h2>
              <div>
                <Badge tone={current.label === "bug" ? "red" : "purple"}>
                  {current.label}
                </Badge>
                {current.id === "184" && (
                  <Badge tone="amber">good first issue</Badge>
                )}
                <span>opened by marina · {current.age} ago</span>
              </div>
            </div>
            <Button onClick={() => go("tests")} icon="test">
              Generate Test
            </Button>
          </div>
          <div className="issue-description">
            <h3>Problem description</h3>
            <p>
              {current.id === "184"
                ? "When a request is retried after a network error, the configured timeout appears to reset to the default 5 seconds instead of preserving the user value."
                : "This issue is synchronized from GitHub. Select the mapped source references to continue investigating its execution path."}
            </p>
            <div className="compare">
              <div>
                <b>Expected</b>
                <p>
                  Every attempt respects the configured{" "}
                  <code>timeout: 1000</code>.
                </p>
              </div>
              <div>
                <b>Actual</b>
                <p>The second attempt waits for the default 5000ms timeout.</p>
              </div>
            </div>
            <h3>Questions before coding</h3>
            <ol>
              <li>Can the behavior be reproduced consistently?</li>
              <li>Which function owns the retry configuration?</li>
              <li>Which existing test is closest to this behavior?</li>
            </ol>
          </div>
          <div className="related">
            <h3>Issue-to-code mapping</h3>
            {[
              ["src/core/request.ts", "Primary request handler", "92%"],
              ["src/middleware/retry.ts", "Recreates request config", "86%"],
              ["tests/request.test.ts", "Existing timeout tests", "78%"],
            ].map((x) => (
              <button key={x[0]} onClick={() => go("explorer")}>
                <Icon name="file" />
                <span>
                  <b>{x[0]}</b>
                  <small>{x[1]}</small>
                </span>
                <Badge tone="purple">{x[2]} relevant</Badge>
              </button>
            ))}
          </div>
        </main>
        <aside className="investigation">
          <div className="ai-head">
            <span>
              <Icon name="spark" />
              AI investigation
            </span>
            <Badge tone="neutral">Draft</Badge>
          </div>
          <section>
            <Badge tone="green">CONFIRMED</Badge>
            <h3>Timeout config is read correctly</h3>
            <p>
              <code>request.ts:8</code> uses the provided timeout on the initial
              request.
            </p>
          </section>
          <section>
            <Badge tone="amber">SUSPECTED</Badge>
            <h3>Retry creates a partial config</h3>
            <p>
              <code>retry.ts:42</code> forwards headers and body, but timeout is
              not explicitly copied.
            </p>
          </section>
          <section>
            <Badge tone="red">UNKNOWN</Badge>
            <h3>Behavior needs reproduction</h3>
            <p>
              Add a focused test that advances time through the second attempt.
            </p>
          </section>
          <div className="confidence">
            <div>
              <span>Investigation confidence</span>
              <b>Medium · 74%</b>
            </div>
            <div>
              <i />
            </div>
            <p>Confidence is limited until a generated test is executed.</p>
          </div>
          <Button onClick={() => go("tests")} icon="test">
            Generate focused test
          </Button>
          <Button kind="secondary" onClick={() => go("guide")}>
            Add to contribution path
          </Button>
        </aside>
      </div>
    </div>
  )
}

function LiveIssues({ go }: { go: (s: Screen) => void }) {
  const { analysis, issues, setIssues, selectedIssue, setSelectedIssue } =
    useWorkspace()
  const [query, setQuery] = useState("")
  const [state, setState] = useState("all")
  const [label, setLabel] = useState("all")
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    if (!selectedIssue && issues[0]) setSelectedIssue(issues[0])
  }, [issues, selectedIssue, setSelectedIssue])
  if (!analysis) return null
  const labels = [...new Set(issues.flatMap((issue) => issue.labels))].sort()
  const filtered = issues.filter(
    (issue) =>
      (state === "all" || issue.state === state) &&
      (label === "all" || issue.labels.includes(label)) &&
      `${issue.number} ${issue.title} ${issue.body}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  )
  const current =
    selectedIssue &&
    issues.some((issue) => issue.number === selectedIssue.number)
      ? selectedIssue
      : (filtered[0] ?? null)
  const related = current ? inferRelevantFiles(current, analysis) : []
  const sync = async () => {
    setSyncing(true)
    setError("")
    try {
      const next = await fetchIssues(analysis.repo.owner, analysis.repo.name)
      setIssues(next)
      if (current)
        setSelectedIssue(
          next.find((issue) => issue.number === current.number) ??
            next[0] ??
            null,
        )
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to refresh issues.",
      )
    } finally {
      setSyncing(false)
    }
  }
  return (
    <div className="page issue-page">
      <div className="page-title compact">
        <div>
          <p>LIVE GITHUB ISSUES</p>
          <h1>Investigate repository issues</h1>
          <span>
            Issue descriptions and metadata are read directly from GitHub.
          </span>
        </div>
        <Button kind="secondary" onClick={sync} disabled={syncing}>
          {syncing ? "Syncing…" : "Sync from GitHub"}
        </Button>
      </div>
      {error && (
        <div className="inline-error">
          <Icon name="issue" size={14} />
          {error}
        </div>
      )}
      <div className="issue-layout">
        <aside className="issues-list">
          <label className="file-search">
            <Icon name="search" size={14} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search issue text"
            />
          </label>
          <div className="filter-row">
            <select
              value={state}
              onChange={(e) => setState(e.target.value)}
              aria-label="Issue status"
            >
              <option value="all">All states</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
            <select
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              aria-label="Issue label"
            >
              <option value="all">All labels</option>
              {labels.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </div>
          {filtered.map((issue) => (
            <button
              className={current?.number === issue.number ? "active" : ""}
              onClick={() => setSelectedIssue(issue)}
              key={issue.number}
            >
              <div>
                <span>#{issue.number}</span>
                <small>{new Date(issue.createdAt).toLocaleDateString()}</small>
              </div>
              <b>{issue.title}</b>
              <div className="issue-labels">
                <Badge tone={issue.state === "open" ? "green" : "neutral"}>
                  {issue.state}
                </Badge>
                {issue.labels.slice(0, 2).map((item) => (
                  <Badge key={item} tone="purple">
                    {item}
                  </Badge>
                ))}
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="empty-inline">
              No GitHub issues match these filters.
            </p>
          )}
        </aside>
        {current ? (
          <>
            <main className="issue-detail">
              <div className="issue-heading">
                <div>
                  <span>
                    #{current.number} · {current.state}
                  </span>
                  <h2>{current.title}</h2>
                  <div>
                    {current.labels.map((item) => (
                      <Badge key={item} tone="purple">
                        {item}
                      </Badge>
                    ))}
                    <span>opened by {current.author}</span>
                  </div>
                </div>
                <a
                  className="button secondary"
                  href={current.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on GitHub ↗
                </a>
              </div>
              <div className="issue-description">
                <h3>Repository issue description</h3>
                <div className="markdown-body">
                  {current.body.split("\n").map((line, i) => (
                    <p key={i}>{line || " "}</p>
                  ))}
                </div>
              </div>
              <div className="related">
                <h3>Issue-to-code candidates</h3>
                {related.map((item) => (
                  <button key={item.path} onClick={() => go("explorer")}>
                    <Icon name="file" />
                    <span>
                      <b>{item.path}</b>
                      <small>{item.reason}</small>
                    </span>
                    <Badge tone="amber">
                      {Math.min(item.score, 99)} relevance
                    </Badge>
                  </button>
                ))}
                {related.length === 0 && (
                  <div className="empty-card">
                    No path-level matches were found. Use contextual source
                    search with terms from the issue.
                  </div>
                )}
              </div>
            </main>
            <aside className="investigation">
              <div className="ai-head">
                <span>
                  <Icon name="spark" />
                  Evidence review
                </span>
                <Badge tone="green">SOURCE-BASED</Badge>
              </div>
              <section>
                <Badge tone="green">CONFIRMED</Badge>
                <h3>Issue and repository state</h3>
                <p>
                  Issue #{current.number} is {current.state};{" "}
                  {analysis.files.length} Git tree entries and{" "}
                  {analysis.testFiles.length} test files are indexed.
                </p>
              </section>
              <section>
                <Badge tone="amber">SUSPECTED</Badge>
                <h3>Relevant implementation areas</h3>
                <p>
                  {related
                    .slice(0, 3)
                    .map((item) => item.path)
                    .join(", ") || "No path-level candidates yet"}
                  . Relevance is heuristic until source search confirms symbol
                  usage.
                </p>
              </section>
              <section>
                <Badge tone="red">UNKNOWN</Badge>
                <h3>Reproduction status</h3>
                <p>
                  No execution evidence exists until an isolated runner is
                  connected and the contributor approves a test run.
                </p>
              </section>
              <div className="beginner-guidance">
                <h3>Before coding</h3>
                <ol>
                  <li>Read the issue and linked discussions on GitHub.</li>
                  <li>Open each mapped file and verify the behavior.</li>
                  <li>Find the nearest existing test.</li>
                  <li>Define a reproducible expected outcome.</li>
                </ol>
              </div>
              <Button onClick={() => go("tests")} icon="test">
                Prepare a focused test
              </Button>
              <Button kind="secondary" onClick={() => go("explorer")}>
                Search source evidence
              </Button>
            </aside>
          </>
        ) : (
          <div className="no-selection">
            <Icon name="issue" size={28} />
            <h2>No issue selected</h2>
            <p>This repository has no matching issues.</p>
          </div>
        )}
      </div>
    </div>
  )
}

function LiveExplorer({ go }: { go: (s: Screen) => void }) {
  const { analysis } = useWorkspace()
  const [mode, setMode] = useState<"code" | "graph" | "search">("code")
  const candidates = useMemo(
    () => (analysis ? sourceFilePaths(analysis.files) : []),
    [analysis],
  )
  const [selected, setSelected] = useState(
    analysis?.importantFiles.find((path) => candidates.includes(path)) ??
      candidates[0] ??
      analysis?.importantFiles[0] ??
      "",
  )
  const [fileQuery, setFileQuery] = useState("")
  const [content, setContent] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [level, setLevel] = useState<"Beginner" | "Intermediate" | "Advanced">(
    "Beginner",
  )
  const [action, setAction] = useState("Explain File")
  const [codeQuery, setCodeQuery] = useState("")
  const [results, setResults] = useState<Array<{
    path: string
    line: number
    text: string
  }>>([])
  const [searching, setSearching] = useState(false)
  const [architecture, setArchitecture] = useState<Array<{
    from: string
    to: string
  }>>([])
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null)
  const [aiAnswer, setAiAnswer] = useState("")
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState("")
  useEffect(() => {
    getAiStatus()
      .then(setAiStatus)
      .catch(() => setAiStatus({ configured: false, model: "Unavailable" }))
  }, [])
  useEffect(() => {
    if (!analysis || !selected) return
    let active = true
    setLoading(true)
    setError("")
    setAiAnswer("")
    fetchTextFile(
      analysis.repo.owner,
      analysis.repo.name,
      analysis.repo.defaultBranch,
      selected,
    )
      .then((text) => active && setContent(text))
      .catch(
        (reason) =>
          active &&
          setError(
            reason instanceof Error ? reason.message : "Unable to load file.",
          ),
      )
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [analysis, selected])
  if (!analysis) return null
  const allFiles = analysis.files
    .filter((file) => file.type === "blob")
    .map((file) => file.path)
  const visible = allFiles
    .filter((path) => path.toLowerCase().includes(fileQuery.toLowerCase()))
    .slice(0, 350)
  const lines = content.split("\n")
  const imports = lines.flatMap((line) => {
    const match = line.match(/(?:from\s+|require\s*\(|import\s*\()["']([^"']+)/)
    return match ? [match[1]] : []
  })
  const definitions = lines
    .filter((line) =>
      /\b(function|class|interface|type|const|def|func|struct|enum)\b/.test(
        line,
      ),
    )
    .slice(0, 8)
  const explanation =
    action === "Show Dependencies"
      ? `${selected} imports ${
          imports.length ? imports.join(", ") : "no directly detectable modules"
        }.`
      : action === "Trace Execution Flow"
        ? `The file declares ${definitions.length} prominent symbols. Read exported definitions first, then follow ${imports.length} imported modules to trace execution.`
        : action === "Find Related Tests"
          ? `${analysis.testFiles.filter((path) => path.toLowerCase().includes(selected.split("/").pop()?.split(".")[0].toLowerCase() ?? "")).join(", ") || "No name-matched test file was found. Use contextual search for calls and assertions."}`
        : `${selected} contains ${lines.length.toLocaleString()} lines, ${definitions.length} detected declarations, and ${imports.length} direct imports. ${
            level === "Beginner"
              ? "Start with its exports and read each imported module only when needed."
              : level === "Intermediate"
                ? "Review data entering exported symbols, then trace side effects and error paths."
                : "Inspect module boundaries, state transitions, error propagation, and test seams before changing behavior."
          }`
  const runAiExplanation = async () => {
    setAiLoading(true)
    setAiError("")
    try {
      const result = await explainWithGroq({
        task: action,
        level,
        repository: analysis.repo.fullName,
        branch: analysis.repo.defaultBranch,
        file: selected,
        // Keep the full request comfortably below Groq's free-tier 8K TPM cap,
        // leaving room for the prompt and generated answer.
        source: content.slice(0, 14_000),
        sourceNotice:
          content.length > 14_000
            ? `This is the first 14,000 characters of ${content.length.toLocaleString()} total characters.`
            : "Complete file supplied.",
        detectedImports: imports,
        relatedTests: analysis.testFiles.filter((path) =>
          path
            .toLowerCase()
            .includes(
              selected.split("/").pop()?.split(".")[0].toLowerCase() ?? "",
            ),
        ),
      })
      setAiAnswer(result.content)
    } catch (reason) {
      setAiError(
        reason instanceof Error ? reason.message : "Groq request failed.",
      )
    } finally {
      setAiLoading(false)
    }
  }
  const runSearch = async () => {
    if (!codeQuery.trim()) return
    setSearching(true)
    setResults([])
    const needle = codeQuery.trim().toLowerCase()
    const paths = candidates
      .filter((path) => {
        const file = analysis.files.find((item) => item.path === path)
        return !file?.size || file.size < 160000
      })
      .slice(0, 45)
    const found: Array<{ path: string; line: number; text: string }> = []
    await Promise.all(
      paths.map(async (path) => {
        try {
          const text = await fetchTextFile(
            analysis.repo.owner,
            analysis.repo.name,
            analysis.repo.defaultBranch,
            path,
          )
          text.split("\n").forEach((line, index) => {
            if (found.length < 100 && line.toLowerCase().includes(needle))
              found.push({ path, line: index + 1, text: line.trim() })
          })
        } catch {
          /* unreadable source files are skipped */
        }
      }),
    )
    setResults(
      found.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line),
    )
    setSearching(false)
    setMode("search")
  }
  const mapArchitecture = async () => {
    setLoading(true)
    const paths = analysis.importantFiles
      .filter((path) => candidates.includes(path))
      .slice(0, 18)
    const edges: Array<{ from: string; to: string }> = []
    await Promise.all(
      paths.map(async (path) => {
        try {
          const text = await fetchTextFile(
            analysis.repo.owner,
            analysis.repo.name,
            analysis.repo.defaultBranch,
            path,
          )
          text.split("\n").forEach((line) => {
            const match = line.match(
              /(?:from\s+|require\s*\(|import\s*\()["']([^"']+)/,
            )
            if (match) edges.push({ from: path, to: match[1] })
          })
        } catch {
          /* skip */
        }
      }),
    )
    setArchitecture(edges.slice(0, 80))
    setLoading(false)
    setMode("graph")
  }
  return (
    <div className="explorer">
      <div className="explorer-toolbar">
        <div className="breadcrumbs">
          <span>{analysis.repo.owner}</span>
          <Icon name="chevron" size={12} />
          <b>{analysis.repo.name}</b>
          <Badge tone="neutral">
            <Icon name="branch" size={12} />
            {analysis.repo.defaultBranch}
          </Badge>
        </div>
        <div className="view-tabs">
          <button
            className={mode === "code" ? "active" : ""}
            onClick={() => setMode("code")}
          >
            <Icon name="code" size={15} />
            Code
          </button>
          <button
            className={mode === "graph" ? "active" : ""}
            onClick={mapArchitecture}
          >
            <Icon name="layers" size={15} />
            Architecture
          </button>
          <button
            className={mode === "search" ? "active" : ""}
            onClick={() => setMode("search")}
          >
            <Icon name="search" size={15} />
            Search
          </button>
        </div>
        <div className="tool-buttons">
          <span>{allFiles.length.toLocaleString()} files</span>
        </div>
      </div>
      <div className="explorer-grid">
        <aside className="file-panel">
          <div className="panel-title">
            <b>LIVE FILE TREE</b>
            <span>
              {visible.length}
              {visible.length === 350 ? "+" : ""}
            </span>
          </div>
          <label className="file-search">
            <Icon name="search" size={14} />
            <input
              value={fileQuery}
              onChange={(e) => setFileQuery(e.target.value)}
              placeholder="Filter indexed paths"
            />
          </label>
          {visible.map((path) => (
            <button
              key={path}
              className={selected === path ? "selected" : ""}
              onClick={() => {
                setSelected(path)
                setMode("code")
              }}
            >
              <Icon
                name={
                  /\.(tsx?|jsx?|py|go|rs|java|rb|php|cs)$/i.test(path)
                    ? "file"
                    : "code"
                }
                size={14}
              />
              <span title={path}>{path}</span>
              {analysis.testFiles.includes(path) && (
                <Badge tone="green">TEST</Badge>
              )}
            </button>
          ))}
          {visible.length === 0 && (
            <p className="empty-inline">No indexed paths match.</p>
          )}
        </aside>
        <section className="editor">
          {mode === "code" ? (
            <>
              <div className="editor-tabs">
                <div>
                  <Icon name="file" size={14} />
                  {selected.split("/").pop()}
                  <span>×</span>
                </div>
              </div>
              <div className="editor-bar">
                <div>
                  <b>{selected}</b>
                </div>
                <div>
                  <button
                    onClick={() => navigator.clipboard?.writeText(content)}
                  >
                    Copy file
                  </button>
                  <a
                    href={`${analysis.repo.htmlUrl}/blob/${analysis.repo.defaultBranch}/${selected}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    GitHub ↗
                  </a>
                </div>
              </div>
              {loading ? (
                <div className="workspace-loading">
                  <i className="spinner" />
                  Loading source from GitHub…
                </div>
              ) : error ? (
                <div className="workspace-error">{error}</div>
              ) : (
                <pre className="live-code">
                  {lines.map((line, i) => (
                    <div key={i}>
                      <span>{i + 1}</span>
                      <code>{line || " "}</code>
                    </div>
                  ))}
                </pre>
              )}
            </>
          ) : mode === "graph" ? (
            <div className="live-architecture">
              <div className="arch-head">
                <div>
                  <h2>Import architecture</h2>
                  <p>
                    Edges parsed from real import statements in important files.
                  </p>
                </div>
                <Badge tone="green">{architecture.length} edges</Badge>
              </div>
              {architecture.length ? (
                <div className="edge-list">
                  {architecture.map((edge, i) => (
                    <button
                      key={`${edge.from}-${edge.to}-${i}`}
                      onClick={() => {
                        setSelected(edge.from)
                        setMode("code")
                      }}
                    >
                      <span>{edge.from}</span>
                      <Icon name="arrow" size={13} />
                      <b>{edge.to}</b>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-result">
                  <span>
                    <Icon name="layers" />
                  </span>
                  <h3>No import edges detected</h3>
                  <p>
                    The selected language may not use JavaScript-style import
                    syntax.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="context-search">
              <div className="search-hero">
                <Badge tone="purple">CONTEXTUAL CODE SEARCH</Badge>
                <h2>Find definitions, calls, and likely tests</h2>
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    runSearch()
                  }}
                >
                  <Icon name="search" />
                  <input
                    value={codeQuery}
                    onChange={(e) => setCodeQuery(e.target.value)}
                    placeholder="Function, class, symbol, or text"
                  />
                  <Button disabled={searching}>
                    {searching
                      ? "Searching source…"
                      : "Search loaded repository"}
                  </Button>
                </form>
                <p>
                  Search reads up to 45 source files directly from the selected
                  branch. Results are source evidence, not generated examples.
                </p>
              </div>
              <div className="search-results">
                {results.map((result, i) => (
                  <button
                    key={`${result.path}-${result.line}-${i}`}
                    onClick={() => {
                      setSelected(result.path)
                      setMode("code")
                    }}
                  >
                    <Badge
                      tone={/test|spec/.test(result.path) ? "green" : "neutral"}
                    >
                      {/test|spec/.test(result.path) ? "TEST" : "SOURCE"}
                    </Badge>
                    <span>
                      <b>
                        {result.path}:{result.line}
                      </b>
                      <code>{result.text}</code>
                    </span>
                    <Icon name="chevron" size={14} />
                  </button>
                ))}
                {!searching && results.length === 0 && codeQuery && (
                  <div className="empty-card">
                    No matches found in the searched source files.
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
        <aside className="ai-panel">
          <div className="ai-head">
            <span>
              <Icon name="spark" />
              Groq code explainer
            </span>
            <div className="level-switch">
              {(["Beginner", "Intermediate", "Advanced"] as const).map((x) => (
                <button
                  key={x}
                  className={level === x ? "active" : ""}
                  onClick={() => setLevel(x)}
                >
                  {x[0]}
                </button>
              ))}
            </div>
          </div>
          <div className="ai-scroll">
            <div className="quick-actions">
              {[
                "Explain File",
                "Show Dependencies",
                "Trace Execution Flow",
                "Find Related Tests",
              ].map((x) => (
                <button
                  className={action === x ? "active" : ""}
                  onClick={() => setAction(x)}
                  key={x}
                >
                  {x}
                  <Icon name="arrow" size={13} />
                </button>
              ))}
            </div>
            <div className="ai-generate-row">
              <div>
                <Badge tone={aiStatus?.configured ? "green" : "amber"}>
                  {aiStatus?.configured ? "GROQ CONNECTED" : "GROQ NOT CONFIGURED"}
                </Badge>
                <small>{aiStatus?.model ?? "Checking server…"}</small>
              </div>
              <Button
                onClick={runAiExplanation}
                disabled={!aiStatus?.configured || aiLoading || !content}
                icon="spark"
              >
                {aiLoading ? "Generating…" : "Generate with Groq"}
              </Button>
            </div>
            {aiError && <div className="ai-inline-error">{aiError}</div>}
            <div className="answer">
              <div className="answer-head">
                <span className="ai-avatar">
                  <Icon name="spark" size={15} />
                </span>
                <div>
                  <b>{action}</b>
                  <small>
                    {aiAnswer
                      ? `${level} · generated by ${aiStatus?.model}`
                      : `${level} · deterministic source summary`}
                  </small>
                </div>
              </div>
              {aiAnswer ? (
                <MarkdownAnswer content={aiAnswer} />
              ) : (
                <p>{explanation}</p>
              )}
              <div className="evidence-card">
                <Badge tone="green">SOURCE EVIDENCE</Badge>
                <p>
                  <b>{selected}</b>
                  <br />
                  {lines.length} lines read from {analysis.repo.defaultBranch}.
                </p>
              </div>
            </div>
            <div className="learning-path">
              <b>Repository learning path</b>
              <ol>
                {analysis.importantFiles.slice(0, 6).map((path) => (
                  <li key={path}>
                    <button
                      onClick={() => {
                        setSelected(path)
                        setMode("code")
                      }}
                    >
                      {path}
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          </div>
          <div className="ask-box">
            <Button
              kind="secondary"
              onClick={() => setMode("search")}
              icon="search"
            >
              Ask through source search
            </Button>
            <small>
              Repository source is sent to Groq only when you press Generate.
            </small>
          </div>
        </aside>
      </div>
      <div className="mobile-screen-nav">
        <button onClick={() => go("issues")}>
          <Icon name="issue" />
          Open repository issues
        </button>
      </div>
    </div>
  )
}

function LiveDashboard({ go }: { go: (s: Screen) => void }) {
  const { analysis, setAnalysis, issues, setIssues, setSelectedIssue } =
    useWorkspace()
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState("")
  if (!analysis) return null
  const refresh = async () => {
    setRefreshing(true)
    setError("")
    try {
      const next = await analyzeRepository(analysis.repo.htmlUrl)
      setAnalysis(next)
      try {
        setIssues(await fetchIssues(next.repo.owner, next.repo.name))
      } catch {
        setIssues([])
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Refresh failed.")
    } finally {
      setRefreshing(false)
    }
  }
  const openIssue = (issue: GitHubIssue) => {
    setSelectedIssue(issue)
    go("issues")
  }
  const analyzed = new Date(analysis.analyzedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })
  return (
    <div className="page dashboard-page">
      <div className="page-title">
        <div>
          <p>LIVE REPOSITORY OVERVIEW</p>
          <h1>{analysis.repo.fullName}</h1>
          <span>{analysis.repo.description}</span>
        </div>
        <div className="title-actions">
          <Button
            kind="secondary"
            onClick={refresh}
            disabled={refreshing}
            icon="command"
          >
            {refreshing ? "Refreshing…" : "Refresh from GitHub"}
          </Button>
          <Button onClick={() => go("connect")} icon="plus">
            Change Repository
          </Button>
        </div>
      </div>
      {error && (
        <div className="inline-error">
          <Icon name="issue" size={14} />
          {error}
        </div>
      )}
      <section className="repo-overview panel">
        <div className="repo-identity">
          <span className="repo-avatar">
            {analysis.repo.name.slice(0, 2).toUpperCase()}
          </span>
          <div>
            <div className="eyebrow">
              {analysis.repo.visibility.toUpperCase()} REPOSITORY
            </div>
            <h2>{analysis.repo.fullName}</h2>
            <p>
              Updated on GitHub{" "}
              {new Date(analysis.repo.updatedAt).toLocaleDateString()}
            </p>
          </div>
        </div>
        <div className="overview-facts">
          <div>
            <span>Default branch</span>
            <b>
              <Icon name="branch" size={13} />
              {analysis.repo.defaultBranch}
            </b>
          </div>
          <div>
            <span>Analysis</span>
            <b className="healthy">Live · complete</b>
          </div>
          <div>
            <span>Files indexed</span>
            <b>
              {analysis.files
                .filter((file) => file.type === "blob")
                .length.toLocaleString()}
            </b>
          </div>
          <div>
            <span>Tests detected</span>
            <b>{analysis.testFiles.length}</b>
          </div>
          <div>
            <span>Analyzed</span>
            <b>{analyzed}</b>
          </div>
        </div>
        <div className="tech-row">
          <span>Detected stack</span>
          {analysis.technologies.slice(0, 7).map((tech, i) => (
            <Badge key={tech} tone={i === 0 ? "purple" : "neutral"}>
              {tech}
            </Badge>
          ))}
          <button onClick={() => go("explorer")}>
            Explore source <Icon name="arrow" size={13} />
          </button>
        </div>
      </section>
      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Automatic analysis</h2>
              <p>Derived from the Git tree and manifests</p>
            </div>
          </div>
          <div className="analysis-facts">
            <div>
              <Icon name="code" />
              <span>
                <b>{analysis.entryPoints.length} entry points</b>
                <small>
                  {analysis.entryPoints.slice(0, 2).join(" · ") ||
                    "No conventional entry point found"}
                </small>
              </span>
            </div>
            <div>
              <Icon name="test" />
              <span>
                <b>{analysis.testFiles.length} test files</b>
                <small>
                  {analysis.testFiles.slice(0, 2).join(" · ") ||
                    "No conventional tests found"}
                </small>
              </span>
            </div>
            <div>
              <Icon name="layers" />
              <span>
                <b>{analysis.dependencies.length} dependencies</b>
                <small>
                  {analysis.dependencies
                    .slice(0, 4)
                    .map((item) => item.name)
                    .join(" · ") || "No package.json dependencies"}
                </small>
              </span>
            </div>
            <div>
              <Icon name="folder" />
              <span>
                <b>
                  {
                    new Set(
                      analysis.files.map((file) => file.path.split("/")[0]),
                    ).size
                  }{" "}
                  top-level paths
                </b>
                <small>
                  {[
                    ...new Set(
                      analysis.files.map((file) => file.path.split("/")[0]),
                    ),
                  ]
                    .slice(0, 5)
                    .join(" · ")}
                </small>
              </span>
            </div>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Repository issues</h2>
              <p>{issues.length} issues loaded from GitHub</p>
            </div>
            <button onClick={() => go("issues")}>View all</button>
          </div>
          <div className="live-issues">
            {issues.slice(0, 4).map((issue) => (
              <button key={issue.number} onClick={() => openIssue(issue)}>
                <Icon name="issue" />
                <span>
                  <b>
                    #{issue.number} · {issue.title}
                  </b>
                  <small>
                    {issue.state} · {issue.labels.join(", ") || "no labels"}
                  </small>
                </span>
                <Icon name="chevron" size={14} />
              </button>
            ))}
            {issues.length === 0 && (
              <div className="empty-card">
                No repository issues were returned by GitHub.
              </div>
            )}
          </div>
        </section>
      </div>
      <section className="panel learning-overview">
        <div className="panel-head">
          <div>
            <h2>Suggested learning path</h2>
            <p>Important files ranked from repository structure</p>
          </div>
          <Button kind="secondary" onClick={() => go("explorer")}>
            Start exploring
          </Button>
        </div>
        <div>
          {analysis.importantFiles.slice(0, 6).map((path, i) => (
            <button key={path} onClick={() => go("explorer")}>
              <span>{i + 1}</span>
              <div>
                <b>{path}</b>
                <small>
                  {i === 0
                    ? "Project setup and orientation"
                    : i < 3
                      ? "Core entry point or configuration"
                      : "Architecture context"}
                </small>
              </div>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

function Tests({ go }: { go: (s: Screen) => void }) {
  const [status, setStatus] = useState<"proposed" | "running" | "passed">(
    "proposed",
  )

  useEffect(() => {
    if (status === "running") {
      const t = setTimeout(() => setStatus("passed"), 1400)
      return () => clearTimeout(t)
    }
  }, [status])

  return (
    <div className="page tests-page">
      <div className="page-title compact">
        <div>
          <p>TEST LAB</p>
          <h1>Verify expected behavior</h1>
          <span>Generate a focused test, then run it to gather evidence.</span>
        </div>
        <Badge tone={status === "passed" ? "green" : "amber"}>
          {status === "passed" ? "EXECUTED · PASSED" : "PROPOSED · NOT RUN"}
        </Badge>
      </div>
      <div className="stats">
        {[
          ["3", "Total tests", "neutral"],
          [status === "passed" ? "3" : "2", "Passed", "green"],
          ["0", "Failed", "red"],
          [status === "passed" ? "0" : "1", "Not run", "amber"],
        ].map((x) => (
          <div key={x[1]}>
            <Badge tone={x[2] as "neutral" | "green" | "red" | "amber"}>
              {x[0]}
            </Badge>
            <span>{x[1]}</span>
          </div>
        ))}
      </div>
      <div className="test-layout">
        <section className="test-config panel">
          <div className="panel-head">
            <div>
              <h2>Test setup</h2>
              <p>Issue #184 · Request timeout</p>
            </div>
          </div>
          <label>Expected behavior</label>
          <textarea defaultValue="The configured 1000ms timeout is preserved after a retry." />
          <label>Actual behavior</label>
          <textarea defaultValue="The retried request falls back to the default 5000ms timeout." />
          <label>Framework</label>
          <div className="select">
            <Icon name="test" />
            <span>Vitest</span>
            <Icon name="chevron" size={14} />
          </div>
          <div className="preconditions">
            <b>Preconditions & steps</b>
            <ol>
              <li>Use fake timers</li>
              <li>Fail the first request</li>
              <li>Advance by 1000ms</li>
              <li>Assert second request aborts</li>
            </ol>
          </div>
          <Button kind="secondary" icon="spark">
            Regenerate test
          </Button>
        </section>
        <section className="test-editor panel">
          <div className="test-editor-head">
            <div>
              <Icon name="file" />
              request.retry.test.ts
            </div>
            <Badge tone={status === "passed" ? "green" : "amber"}>
              {status === "passed" ? "VERIFIED" : "PROPOSED TEST"}
            </Badge>
          </div>
          <pre>
            <code>
              <span className="kw">it</span>(
              <span className="str">'preserves timeout after retry'</span>,{" "}
              <span className="kw">async</span> () ={`>`} {"{"}
              <br />
              {"  "}vi.useFakeTimers();
              <br />
              {"  "}
              <span className="kw">const</span> client = createClient({"{"}{" "}
              timeout: <span className="num">1000</span> {"}"});
              <br />
              <br />
              {"  "}
              <span className="kw">const</span> result = client.get(
              <span className="str">'/slow'</span>);
              <br />
              {"  "}mockFetch.failOnce(<span className="str">'ECONNRESET'</span>
              );
              <br />
              {"  "}vi.advanceTimersByTime(<span className="num">1000</span>);
              <br />
              <br />
              {"  "}
              <span className="kw">await</span> expect(result).rejects
              <br />
              {"    "}.toBeInstanceOf(TimeoutError);
              <br />
              {"}"});
            </code>
          </pre>
          <div className="run-row">
            <div>
              <b>
                {status === "passed"
                  ? "Execution complete"
                  : "Ready to execute"}
              </b>
              <small>
                {status === "passed"
                  ? "Ran locally in demo environment"
                  : "Running this test is simulated in this prototype"}
              </small>
            </div>
            <Button
              onClick={() => setStatus("running")}
              disabled={status === "running"}
              icon="play"
            >
              {status === "running"
                ? "Running…"
                : status === "passed"
                  ? "Run again"
                  : "Run Test"}
            </Button>
          </div>
        </section>
        <section className={`console panel ${status}`}>
          <div className="console-head">
            <div>
              <h2>Test results</h2>
              <span>
                {status === "passed" ? "Duration 1.14s" : "Awaiting execution"}
              </span>
            </div>
            <Badge tone={status === "passed" ? "green" : "neutral"}>
              {status === "passed" ? "PASSED" : "NOT RUN"}
            </Badge>
          </div>
          {status === "running" ? (
            <div className="running-state">
              <i className="spinner" />
              <b>Executing test…</b>
              <span>Setting up isolated test environment</span>
            </div>
          ) : status === "passed" ? (
            <>
              <div className="result-banner">
                <span>
                  <Icon name="check" />
                </span>
                <div>
                  <b>All assertions passed</b>
                  <p>
                    The retry attempt was aborted after the configured 1000ms
                    timeout.
                  </p>
                </div>
              </div>
              <div className="console-output">
                <b>CONSOLE OUTPUT</b>
                <pre>
                  ✓ request.retry.test.ts (1)
                  <br /> ✓ preserves timeout after retry 12ms
                  <br />
                  <br />
                  Test Files 1 passed (1)
                  <br />
                  Tests 1 passed (1)
                  <br />
                  Duration 1.14s
                </pre>
              </div>
              <Button onClick={() => go("guide")} icon="arrow">
                Continue to contribution guide
              </Button>
            </>
          ) : (
            <div className="empty-result">
              <span>
                <Icon name="play" />
              </span>
              <h3>This test hasn’t been run</h3>
              <p>
                Generated code is a proposal, not evidence. Run the test to
                verify the behavior.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

type TestState = "not-run" | "running" | "passed" | "failed" | "error" | "unable"

function TestLab({ go }: { go: (s: Screen) => void }) {
  const [state, setState] = useState<TestState>("not-run")
  const [approved, setApproved] = useState(false)
  const [outcome, setOutcome] =
    useState<Exclude<TestState, "not-run" | "running">>("passed")
  useEffect(() => {
    if (state === "running") {
      const t = window.setTimeout(() => setState(outcome), 1200)
      return () => window.clearTimeout(t)
    }
  }, [state, outcome])
  const meta = {
    "not-run": ["NOT RUN", "amber"],
    running: ["RUNNING", "amber"],
    passed: ["PASSED", "green"],
    failed: ["FAILED", "red"],
    error: ["EXECUTION ERROR", "red"],
    unable: ["UNABLE TO REPRODUCE", "neutral"],
  } as const
  const copy = {
    passed: [
      "All assertions passed",
      "The retry attempt aborted after the configured 1000ms timeout.",
    ],
    failed: [
      "Assertion failed",
      "The second request remained active after 1000ms. The issue was reproduced.",
    ],
    error: [
      "Execution could not complete",
      "The isolated runner exited before assertions were evaluated.",
    ],
    unable: [
      "Behavior was not reproduced",
      "The environment did not trigger a retryable network failure.",
    ],
  } as const
  const finished = state !== "not-run" && state !== "running"
  return (
    <div className="page tests-page">
      <div className="page-title compact">
        <div>
          <p>TESTTWIN · TEST LAB</p>
          <h1>Generate and verify a focused test</h1>
          <span>
            Execution requires approval and results remain separate from
            correctness claims.
          </span>
        </div>
        <Badge tone={meta[state][1]}>{meta[state][0]}</Badge>
      </div>
      <div className="test-state-strip">
        {([
          "passed",
          "failed",
          "not-run",
          "error",
          "unable",
        ] as TestState[]).map((x) => (
          <button
            key={x}
            className={state === x ? "active" : ""}
            onClick={() => x !== "not-run" && setOutcome(x as typeof outcome)}
          >
            <i className={`dot ${x}`} />
            {meta[x][0]}
          </button>
        ))}
      </div>
      <div className="test-layout">
        <section className="test-config panel">
          <div className="panel-head">
            <div>
              <h2>Test case generator</h2>
              <p>Issue #184 · Request timeout</p>
            </div>
          </div>
          <label>Expected behavior</label>
          <textarea defaultValue="The configured 1000ms timeout is preserved after a retry." />
          <label>Actual behavior</label>
          <textarea defaultValue="The retried request falls back to the default 5000ms timeout." />
          <label>Framework</label>
          <div className="select">
            <Icon name="test" />
            <span>Vitest · detected</span>
            <Icon name="chevron" size={14} />
          </div>
          <div className="preconditions">
            <b>Generated test plan</b>
            <ol>
              <li>Enable fake timers</li>
              <li>Fail the first request</li>
              <li>Advance by 1000ms</li>
              <li>Assert second request aborts</li>
            </ol>
          </div>
          <Button kind="secondary" icon="spark">
            Regenerate proposal
          </Button>
        </section>
        <section className="test-editor panel">
          <div className="test-editor-head">
            <div>
              <Icon name="file" />
              request.retry.test.ts
            </div>
            <Badge tone="amber">PROPOSED TEST</Badge>
          </div>
          <pre>
            <code>
              <span className="kw">it</span>(
              <span className="str">'preserves timeout after retry'</span>,{" "}
              <span className="kw">async</span> () ={`>`} {"{"}
              <br />
              {"  "}vi.useFakeTimers();
              <br />
              {"  "}
              <span className="kw">const</span> client = createClient({"{"}{" "}
              timeout: <span className="num">1000</span> {"}"});
              <br />
              {"  "}mockFetch.failOnce(<span className="str">'ECONNRESET'</span>
              );
              <br />
              {"  "}vi.advanceTimersByTime(<span className="num">1000</span>);
              <br />
              {"  "}
              <span className="kw">await</span> expect(client.get(
              <span className="str">'/slow'</span>))
              <br />
              {"    "}.rejects.toBeInstanceOf(TimeoutError);
              <br />
              {"}"});
            </code>
          </pre>
          <div className="execution-control">
            <label>
              <input
                type="checkbox"
                checked={approved}
                onChange={(e) => setApproved(e.target.checked)}
              />
              <span>
                <b>Approve isolated execution</b>
                <small>No repository files will be modified.</small>
              </span>
            </label>
            <select
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as typeof outcome)}
              aria-label="Demo result"
            >
              <option value="passed">Demo: pass</option>
              <option value="failed">Demo: fail</option>
              <option value="error">Demo: execution error</option>
              <option value="unable">Demo: unable to reproduce</option>
            </select>
            <Button
              onClick={() => setState("running")}
              disabled={!approved || state === "running"}
              icon="play"
            >
              {state === "running" ? "Running…" : "Run approved test"}
            </Button>
          </div>
        </section>
        <section className={`console panel ${state}`}>
          <div className="console-head">
            <div>
              <h2>Test evidence</h2>
              <span>
                {finished
                  ? "Exit captured · 1.14s"
                  : "Awaiting approved execution"}
              </span>
            </div>
            <Badge tone={meta[state][1]}>{meta[state][0]}</Badge>
          </div>
          {state === "running" ? (
            <div className="running-state">
              <i className="spinner" />
              <b>Executing in isolation…</b>
              <span>Capturing logs, exit code, and assertions</span>
            </div>
          ) : finished ? (
            <>
              <div className={`result-banner ${state}`}>
                <span>
                  <Icon name={state === "passed" ? "check" : "issue"} />
                </span>
                <div>
                  <b>{copy[state][0]}</b>
                  <p>{copy[state][1]}</p>
                </div>
              </div>
              <div className="console-output">
                <b>EXECUTION LOG</b>
                <pre>
                  {state === "passed"
                    ? "✓ request.retry.test.ts (1)\n  ✓ preserves timeout after retry\n\nExit code  0\nTests      1 passed (1)"
                    : state === "failed"
                      ? "× preserves timeout after retry\n  Expected TimeoutError\n  Received pending request\n\nExit code  1"
                      : state === "error"
                        ? "RunnerError: worker process exited unexpectedly\n\nExit code  2\nAssertions  not evaluated"
                        : "Test skipped: retry precondition not observed\n\nExit code  0\nAssertions  inconclusive"}
                </pre>
              </div>
              <p className="verification-note">
                A test result is evidence about this scenario; it does not by
                itself prove the change is correct.
              </p>
              <Button onClick={() => go("guide")} icon="arrow">
                Continue to change validation
              </Button>
            </>
          ) : (
            <div className="empty-result">
              <span>
                <Icon name="play" />
              </span>
              <h3>This proposal hasn’t been run</h3>
              <p>
                Review the generated test, approve isolated execution, and
                capture a real outcome.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function RealTestLab({ go }: { go: (s: Screen) => void }) {
  const { analysis, selectedIssue, issues } = useWorkspace()
  const issue = selectedIssue ?? issues[0] ?? null
  const framework = analysis?.technologies.includes("Vitest")
    ? "Vitest"
    : analysis?.technologies.includes("Jest")
      ? "Jest"
      : analysis?.technologies.includes("Pytest")
        ? "Pytest"
        : "Not detected"
  const [expected, setExpected] = useState(
    issue
      ? `The behavior described in issue #${issue.number} should match its expected outcome.`
      : "",
  )
  const [actual, setActual] = useState(
    issue?.body.split("\n").find(Boolean)?.slice(0, 240) ?? "",
  )
  const [evidenceState, setEvidenceState] =
    useState<"not-run" | "passed" | "failed" | "error" | "unable">("not-run")
  const [logs, setLogs] = useState("")
  const [exitCode, setExitCode] = useState("")
  const [notice, setNotice] = useState("")
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null)
  const [generatedCode, setGeneratedCode] = useState("")
  const [generating, setGenerating] = useState(false)
  const [generationError, setGenerationError] = useState("")
  useEffect(() => {
    getAiStatus()
      .then(setAiStatus)
      .catch(() => setAiStatus({ configured: false, model: "Unavailable" }))
  }, [])
  if (!analysis) return null
  const target =
    inferRelevantFiles(
      issue ?? {
        number: 0,
        title: "",
        body: "",
        state: "open",
        htmlUrl: "",
        author: "",
        createdAt: "",
        labels: [],
      },
      analysis,
    )[0]?.path ??
    analysis.entryPoints[0] ??
    "src/index"
  const slug = (issue?.title ?? "repository behavior")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
  const code =
    framework === "Pytest"
      ? `def test_${slug.replace(/ /g, "_").slice(0, 55)}():\n    # Arrange: import the behavior from ${target}\n    # Act: reproduce the steps from issue #${issue?.number ?? "?"}\n    result = None\n\n    # Assert the documented expected behavior\n    assert result is not None\n`
      : framework === "Vitest" || framework === "Jest"
        ? `import { describe, expect, it } from '${
            framework === "Vitest" ? "vitest" : "@jest/globals"
          }';\n\ndescribe('issue #${issue?.number ?? "?"}', () => {\n  it('${slug.replace(/'/g, "\\'").slice(0, 90)}', async () => {\n    // Arrange: import the behavior from ${target}\n    // Act: reproduce the issue steps with controlled inputs\n    const result = undefined;\n\n    // Assert: replace this placeholder with the concrete expected value\n    expect(result).toBeDefined();\n  });\n});\n`
        : `// No supported test framework was detected.\n// Review ${target} and configure a repository-native test command first.\n`
  const meta = {
    "not-run": ["NOT RUN", "amber"],
    passed: ["PASSED", "green"],
    failed: ["FAILED", "red"],
    error: ["EXECUTION ERROR", "red"],
    unable: ["UNABLE TO REPRODUCE", "neutral"],
  } as const
  const copyTest = async () => {
    try {
      await navigator.clipboard.writeText(generatedCode || code)
      setNotice("Proposed test copied")
    } catch {
      setNotice("Clipboard permission was denied")
    }
  }
  const generateWithAi = async () => {
    setGenerating(true)
    setGenerationError("")
    try {
      let targetSource = ""
      try {
        targetSource = await fetchTextFile(
          analysis.repo.owner,
          analysis.repo.name,
          analysis.repo.defaultBranch,
          target,
        )
      } catch {
        // The issue and repository metadata still provide useful context.
      }
      const result = await generateTestWithGroq({
        repository: analysis.repo.fullName,
        branch: analysis.repo.defaultBranch,
        framework,
        issue: issue
          ? { number: issue.number, title: issue.title, body: issue.body }
          : null,
        expectedBehavior: expected,
        reportedBehavior: actual,
        targetFile: target,
        targetSource: targetSource.slice(0, 14_000),
        existingTests: analysis.testFiles.slice(0, 12),
      })
      setGeneratedCode(result.content)
    } catch (reason) {
      setGenerationError(
        reason instanceof Error ? reason.message : "Groq request failed.",
      )
    } finally {
      setGenerating(false)
    }
  }
  return (
    <div className="page tests-page">
      <div className="page-title compact">
        <div>
          <p>TESTTWIN · REPOSITORY-DERIVED TEST</p>
          <h1>Prepare and verify a focused test</h1>
          <span>
            The proposal uses the selected issue and detected framework.
            Placeholders must be reviewed before execution.
          </span>
        </div>
        <Badge tone={meta[evidenceState][1]}>{meta[evidenceState][0]}</Badge>
      </div>
      {notice && (
        <div className="inline-notice">
          <Icon name="check" size={14} />
          {notice}
        </div>
      )}
      <div className="runner-warning">
        <Icon name="issue" />
        <div>
          <b>Isolated runner is not configured</b>
          <p>
            Docker is unavailable in this environment. DevPilot will not execute
            untrusted repository code on the host. Connect a sandbox runner to
            enable approved execution.
          </p>
        </div>
        <Badge tone="amber">SAFETY BLOCK</Badge>
      </div>
      <div className="test-layout">
        <section className="test-config panel">
          <div className="panel-head">
            <div>
              <h2>Test case input</h2>
              <p>
                {issue
                  ? `Live issue #${issue.number}`
                  : "No repository issue selected"}
              </p>
            </div>
          </div>
          <label>Expected behavior</label>
          <textarea
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
          />
          <label>Reported behavior</label>
          <textarea
            value={actual}
            onChange={(e) => setActual(e.target.value)}
          />
          <label>Detected framework</label>
          <div className="select">
            <Icon name="test" />
            <span>{framework}</span>
            <Badge tone={framework === "Not detected" ? "amber" : "green"}>
              {framework === "Not detected" ? "REVIEW" : "DETECTED"}
            </Badge>
          </div>
          <div className="preconditions">
            <b>Source inputs</b>
            <ol>
              <li>
                {issue ? `GitHub issue #${issue.number}` : "No issue selected"}
              </li>
              <li>{target}</li>
              <li>{analysis.testFiles.length} existing test files indexed</li>
              <li>{framework} framework detection</li>
            </ol>
          </div>
          <div className="test-ai-action">
            <div>
              <Badge tone={aiStatus?.configured ? "green" : "amber"}>
                {aiStatus?.configured ? "GROQ CONNECTED" : "GROQ NOT CONFIGURED"}
              </Badge>
              <small>{aiStatus?.model ?? "Checking server…"}</small>
            </div>
            <Button
              onClick={generateWithAi}
              disabled={!aiStatus?.configured || generating || !issue}
              icon="spark"
            >
              {generating ? "Generating…" : "Generate focused test"}
            </Button>
          </div>
          {generationError && (
            <div className="ai-inline-error">{generationError}</div>
          )}
        </section>
        <section className="test-editor panel">
          <div className="test-editor-head">
            <div>
              <Icon name="file" />
              issue-{issue?.number ?? "new"}.test.
              {framework === "Pytest" ? "py" : "ts"}
            </div>
            <Badge tone={generatedCode ? "purple" : "amber"}>
              {generatedCode ? "GROQ GENERATED" : "TEMPLATE · REVIEW"}
            </Badge>
          </div>
          <pre>
            <code>{generatedCode || code}</code>
          </pre>
          <div className="run-row">
            <div>
              <b>{generatedCode ? "AI-generated proposal" : "Fallback template"}</b>
              <small>
                Review imports, fixtures, and assertions before any execution.
              </small>
            </div>
            <Button kind="secondary" onClick={copyTest}>
              Copy test
            </Button>
          </div>
        </section>
        <section className="console panel">
          <div className="console-head">
            <div>
              <h2>Test evidence</h2>
              <span>Record output from an approved external runner</span>
            </div>
            <Badge tone={meta[evidenceState][1]}>
              {meta[evidenceState][0]}
            </Badge>
          </div>
          <div className="evidence-form">
            <label>
              Outcome
              <select
                value={evidenceState}
                onChange={(e) =>
                  setEvidenceState(e.target.value as typeof evidenceState)
                }
              >
                <option value="not-run">Not run</option>
                <option value="passed">Passed</option>
                <option value="failed">Failed</option>
                <option value="error">Execution error</option>
                <option value="unable">Unable to reproduce</option>
              </select>
            </label>
            <label>
              Exit code
              <input
                value={exitCode}
                onChange={(e) => setExitCode(e.target.value)}
                placeholder="e.g. 0"
              />
            </label>
            <label>
              Runner logs
              <textarea
                value={logs}
                onChange={(e) => setLogs(e.target.value)}
                placeholder="Paste output from the isolated runner…"
              />
            </label>
            <p>
              <Icon name="issue" size={13} /> Manually entered evidence is
              labeled as contributor-provided and is not independently verified
              by DevPilot.
            </p>
          </div>
          <div className="validation-note">
            <b>Change validation</b>
            <p>
              {evidenceState === "passed"
                ? "The recorded test passed, but review the diff, affected modules, and additional tests before concluding the change is correct."
                : "No passing execution evidence is currently recorded."}
            </p>
          </div>
          <Button
            onClick={() => go("guide")}
            disabled={evidenceState === "not-run"}
            icon="arrow"
          >
            Continue with recorded evidence
          </Button>
        </section>
      </div>
    </div>
  )
}

function Guide() {
  const initial = [
    true,
    true,
    true,
    true,
    true,
    false,
    false,
    false,
    false,
    false,
  ]

  const [checks, setChecks] = useState(initial)

  const steps = [
    "Understand the issue",
    "Read contribution guidelines",
    "Identify relevant files",
    "Reproduce the issue",
    "Review the proposed change",
    "Run relevant tests",
    "Review the diff",
    "Check formatting and linting",
    "Prepare a commit message",
    "Draft the pull request",
  ]

  const count = checks.filter(Boolean).length

  return (
    <div className="page guide-page">
      <div className="page-title compact">
        <div>
          <p>CONTRIBUTION GUIDE</p>
          <h1>Prepare your contribution</h1>
          <span>
            A guided path from verified evidence to a review-ready pull request.
          </span>
        </div>
        <Badge tone="purple">ISSUE #184</Badge>
      </div>
      <div className="guide-progress">
        <div>
          <span>Contribution readiness</span>
          <b>{count} of 10 steps</b>
        </div>
        <div>
          <i style={{ width: `${count * 10}%` }} />
        </div>
      </div>
      <div className="guide-layout">
        <section className="panel checklist">
          <div className="panel-head">
            <div>
              <h2>Contribution checklist</h2>
              <p>Complete each step before opening a pull request</p>
            </div>
          </div>
          {steps.map((x, i) => (
            <button
              key={x}
              onClick={() =>
                setChecks((c) => c.map((v, j) => (j === i ? !v : v)))
              }
              className={checks[i] ? "done" : i === count ? "current" : ""}
            >
              <span>{checks[i] ? <Icon name="check" size={14} /> : i + 1}</span>
              <div>
                <b>{x}</b>
                <small>
                  {checks[i]
                    ? i === 4
                      ? "User reviewed"
                      : "Complete"
                    : i === 5
                      ? "Test evidence ready"
                      : "Not started"}
                </small>
              </div>
              {i === 5 && !checks[i] && (
                <Badge tone="green">VERIFIED RESULT</Badge>
              )}
            </button>
          ))}
        </section>
        <section className="guide-main">
          <div className="panel evidence-summary">
            <div className="panel-head">
              <div>
                <h2>Change evidence</h2>
                <p>Keep suggestions, reviews, and results distinct</p>
              </div>
            </div>
            <div className="state-columns">
              <div>
                <Badge tone="purple">AI SUGGESTION</Badge>
                <b>Forward timeout in retry config</b>
                <small>src/middleware/retry.ts</small>
              </div>
              <div>
                <Badge tone="amber">USER REVIEWED</Badge>
                <b>Proposed change reviewed</b>
                <small>Reviewed by Alex</small>
              </div>
              <div>
                <Badge tone="green">VERIFIED RESULT</Badge>
                <b>Regression test passed</b>
                <small>1 test · 1.14s</small>
              </div>
            </div>
          </div>
          <div className="panel changed-files">
            <div className="panel-head">
              <div>
                <h2>Changed files</h2>
                <p>2 files · +18 −2</p>
              </div>
              <Button kind="tertiary">Review diff</Button>
            </div>
            <div>
              <Icon name="file" />
              <span>
                <b>src/middleware/retry.ts</b>
                <small>Forwards timeout to retried request</small>
              </span>
              <i>+2 −2</i>
            </div>
            <div>
              <Icon name="file" />
              <span>
                <b>tests/request.retry.test.ts</b>
                <small>Adds timeout regression test</small>
              </span>
              <i>+16</i>
            </div>
          </div>
          <div className="panel pr-draft">
            <div className="panel-head">
              <div>
                <h2>Pull request draft</h2>
                <p>Editable · generated from your verified work</p>
              </div>
              <Badge tone="purple">AI ASSISTED</Badge>
            </div>
            <label>Title</label>
            <input defaultValue="fix: preserve request timeout after retry" />
            <label>Summary</label>
            <textarea defaultValue="Preserves the user-configured timeout when retrying a failed request. This prevents retry attempts from falling back to the default timeout." />
            <label>Testing performed</label>
            <textarea defaultValue="Added a focused Vitest regression test using fake timers. Verified the second request aborts after the configured 1000ms timeout." />
            <div className="draft-actions">
              <Button kind="secondary">Copy markdown</Button>
              <Button>Create pull request draft</Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function Settings() {
  return (
    <div className="page settings-page">
      <div className="page-title compact">
        <div>
          <p>SETTINGS</p>
          <h1>Workspace preferences</h1>
          <span>Manage your account, explanations, and repository access.</span>
        </div>
      </div>
      <div className="settings-layout">
        <nav>
          <button className="active">Profile</button>
          <button>GitHub connection</button>
          <button>AI preferences</button>
          <button>Repositories</button>
          <button>Privacy & access</button>
        </nav>
        <main>
          <section className="panel">
            <h2>User profile</h2>
            <p>Personal details shown in your workspace.</p>
            <div className="profile-edit">
              <span>AM</span>
              <div>
                <label>Display name</label>
                <input defaultValue="Alex Morgan" />
              </div>
            </div>
            <label>Email address</label>
            <input defaultValue="alex@devpilot.dev" disabled />
            <Button>Save changes</Button>
          </section>
          <section className="panel">
            <div className="setting-row">
              <div>
                <h2>GitHub connection</h2>
                <p>
                  Connected as <b>alexmorgan</b> · Read-only repository access
                </p>
              </div>
              <Badge tone="green">CONNECTED</Badge>
            </div>
            <Button kind="secondary">
              <Icon name="github" />
              Manage connection
            </Button>
          </section>
          <section className="panel">
            <h2>AI explanations</h2>
            <p>Choose how much context DevPilot includes in explanations.</p>
            <div className="segmented">
              <button>Concise</button>
              <button className="active">Balanced</button>
              <button>Detailed</button>
            </div>
            <label>Preferred languages</label>
            <div className="tag-field">
              <Badge tone="purple">TypeScript ×</Badge>
              <Badge tone="neutral">Python ×</Badge>
              <span>Add language…</span>
            </div>
          </section>
          <section className="panel danger-zone">
            <h2>Repository access</h2>
            <p>Disconnect Compass and remove its indexed workspace data.</p>
            <Button kind="danger">Disconnect repository</Button>
          </section>
        </main>
      </div>
    </div>
  )
}

function LiveSettings({ go }: { go: (s: Screen) => void }) {
  const { analysis, setAnalysis, setIssues, setSelectedIssue } = useWorkspace()
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null)
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)
  useEffect(() => {
    getAiStatus()
      .then(setAiStatus)
      .catch(() => setAiStatus({ configured: false, model: "Unavailable" }))
    getAuthStatus().then(setAuthStatus).catch(() => setAuthStatus(null))
  }, [])
  const disconnect = () => {
    setAnalysis(null)
    setIssues([])
    setSelectedIssue(null)
    go("connect")
  }
  const logout = async () => {
    await signOutGitHub()
    if (firebaseAuth) await signOutFirebase(firebaseAuth)
    disconnect()
  }
  return (
    <div className="page settings-page">
      <div className="page-title compact">
        <div>
          <p>SETTINGS</p>
          <h1>Workspace connections</h1>
          <span>
            Review which capabilities are connected and which remain
            unavailable.
          </span>
        </div>
      </div>
      <div className="settings-layout">
        <nav>
          <button className="active">Connections</button>
          <button>Analysis</button>
          <button>Execution</button>
          <button>Privacy</button>
        </nav>
        <main>
          <section className="panel">
            <div className="setting-row">
              <div>
                <h2>GitHub account</h2>
                <p>
                  {authStatus?.authenticated
                    ? `Signed in as @${authStatus.user?.login}`
                    : "No authenticated GitHub session."}
                </p>
              </div>
              <Badge tone={authStatus?.authenticated ? "green" : "amber"}>
                {authStatus?.authenticated ? "AUTHENTICATED" : "SIGNED OUT"}
              </Badge>
            </div>
            <p>
              Access tokens stay in an HTTP-only server session and are never
              exposed to application JavaScript.
            </p>
            {authStatus?.authenticated && (
              <Button kind="secondary" onClick={logout}>
                Sign out of GitHub
              </Button>
            )}
          </section>
          <section className="panel">
            <div className="setting-row">
              <div>
                <h2>Connected repository</h2>
                <p>{analysis?.repo.fullName ?? "No repository connected"}</p>
              </div>
              <Badge tone={analysis ? "green" : "neutral"}>
                {analysis ? "INDEXED" : "NONE"}
              </Badge>
            </div>
            {analysis && (
              <Button kind="danger" onClick={disconnect}>
                Disconnect and clear workspace
              </Button>
            )}
          </section>
          <section className="panel">
            <div className="setting-row">
              <div>
                <h2>AI model connection</h2>
                <p>
                  {aiStatus?.configured
                    ? `Groq · ${aiStatus.model}`
                    : "The server is waiting for GROQ_API_KEY."}
                </p>
              </div>
              <Badge tone={aiStatus?.configured ? "green" : "amber"}>
                {aiStatus?.configured ? "CONNECTED" : "NOT CONFIGURED"}
              </Badge>
            </div>
            <p>
              The key remains server-side. Repository source is sent to Groq
              only when you explicitly request an explanation or test.
            </p>
          </section>
          <section className="panel">
            <div className="setting-row">
              <div>
                <h2>Isolated test runner</h2>
                <p>Docker and external sandbox providers are unavailable.</p>
              </div>
              <Badge tone="red">UNAVAILABLE</Badge>
            </div>
            <p>
              Untrusted repository commands are blocked from running on the
              application host.
            </p>
          </section>
        </main>
      </div>
    </div>
  )
}

function ContributionGuide() {
  const steps = [
    "Understand the issue",
    "Read contribution guidelines",
    "Identify relevant files",
    "Reproduce the issue",
    "Review the proposed change",
    "Run relevant tests",
    "Review the diff",
    "Check formatting and linting",
    "Prepare a commit message",
    "Draft the pull request",
  ]
  const [checks, setChecks] = useState([
    true,
    true,
    true,
    true,
    true,
    false,
    false,
    false,
    false,
    false,
  ])
  const [showDiff, setShowDiff] = useState(false)
  const [notice, setNotice] = useState("")
  const [title, setTitle] = useState(
    "fix: preserve request timeout after retry",
  )
  const [summary, setSummary] = useState(
    "Preserves the user-configured timeout when retrying a failed request. This prevents retry attempts from falling back to the default timeout.",
  )
  const [testing, setTesting] = useState(
    "Added a focused Vitest regression test using fake timers. Verified the second request aborts after the configured 1000ms timeout.",
  )
  const count = checks.filter(Boolean).length
  const announce = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(""), 2200)
  }
  const copyDraft = async () => {
    const markdown = `# ${title}\n\n## Summary\n${summary}\n\n## Testing\n${testing}`
    try {
      await navigator.clipboard.writeText(markdown)
      announce("Pull request markdown copied")
    } catch {
      announce("Draft is ready to copy from the fields")
    }
  }
  return (
    <div className="page guide-page">
      <div className="page-title compact">
        <div>
          <p>CONTRIBUTION GUIDE</p>
          <h1>Prepare your contribution</h1>
          <span>
            A guided path from verified evidence to a review-ready pull request.
          </span>
        </div>
        <Badge tone="purple">ISSUE #184</Badge>
      </div>
      {notice && (
        <div className="inline-notice">
          <Icon name="check" size={14} />
          {notice}
        </div>
      )}
      <div className="guide-progress">
        <div>
          <span>Contribution readiness</span>
          <b>{count} of 10 steps</b>
        </div>
        <div>
          <i style={{ width: `${count * 10}%` }} />
        </div>
      </div>
      <div className="guide-layout">
        <section className="panel checklist">
          <div className="panel-head">
            <div>
              <h2>First contribution checklist</h2>
              <p>Select a step when you have personally completed it</p>
            </div>
          </div>
          {steps.map((x, i) => (
            <button
              key={x}
              onClick={() =>
                setChecks((c) => c.map((v, j) => (j === i ? !v : v)))
              }
              className={checks[i] ? "done" : i === count ? "current" : ""}
            >
              <span>{checks[i] ? <Icon name="check" size={14} /> : i + 1}</span>
              <div>
                <b>{x}</b>
                <small>
                  {checks[i]
                    ? "Complete"
                    : i === 5
                      ? "Test evidence available"
                      : "Not started"}
                </small>
              </div>
              {i === 5 && !checks[i] && (
                <Badge tone="green">VERIFIED RESULT</Badge>
              )}
            </button>
          ))}
        </section>
        <section className="guide-main">
          <div className="panel evidence-summary">
            <div className="panel-head">
              <div>
                <h2>Change evidence</h2>
                <p>
                  Passing tests are evidence, not a guarantee of correctness
                </p>
              </div>
            </div>
            <div className="state-columns">
              <div>
                <Badge tone="purple">AI SUGGESTION</Badge>
                <b>Forward timeout in retry config</b>
                <small>Requires contributor review</small>
              </div>
              <div>
                <Badge tone="amber">USER REVIEWED</Badge>
                <b>Proposed change reviewed</b>
                <small>Reviewed by Alex</small>
              </div>
              <div>
                <Badge tone="green">VERIFIED RESULT</Badge>
                <b>Regression test passed</b>
                <small>1 test · 1.14s</small>
              </div>
            </div>
          </div>
          <div className="panel changed-files">
            <div className="panel-head">
              <div>
                <h2>Change review</h2>
                <p>2 files · +18 −2 · request and retry modules affected</p>
              </div>
              <Button kind="tertiary" onClick={() => setShowDiff((v) => !v)}>
                {showDiff ? "Hide diff" : "Review diff"}
              </Button>
            </div>
            <div>
              <Icon name="file" />
              <span>
                <b>src/middleware/retry.ts</b>
                <small>Forwards timeout to retried request</small>
              </span>
              <i>+2 −2</i>
            </div>
            <div>
              <Icon name="file" />
              <span>
                <b>tests/request.retry.test.ts</b>
                <small>Adds timeout regression test</small>
              </span>
              <i>+16</i>
            </div>
            {showDiff && (
              <pre className="diff-view">
                <span>- return request(url, &#123; headers, body &#125;);</span>
                {"\n"}
                <b>
                  + return request(url, &#123; headers, body, timeout:
                  config.timeout &#125;);
                </b>
                {"\n\n"}
                <b>
                  + it('preserves timeout after retry', async () =&gt; &#123;
                  ... &#125;);
                </b>
              </pre>
            )}
          </div>
          <div className="panel pr-draft">
            <div className="panel-head">
              <div>
                <h2>Pull request draft</h2>
                <p>Editable · generated from your reviewed evidence</p>
              </div>
              <Badge tone="purple">AI ASSISTED</Badge>
            </div>
            <label>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
            <label>Problem & implementation</label>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
            <label>Testing evidence</label>
            <textarea
              value={testing}
              onChange={(e) => setTesting(e.target.value)}
            />
            <div className="draft-actions">
              <Button kind="secondary" onClick={copyDraft}>
                Copy markdown
              </Button>
              <Button
                onClick={() =>
                  announce(
                    "Draft prepared — review it before opening on GitHub",
                  )
                }
              >
                Prepare PR draft
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function LiveContributionGuide() {
  const { analysis, selectedIssue, issues } = useWorkspace()
  const issue = selectedIssue ?? issues[0] ?? null
  const steps = [
    "Understand the issue",
    "Read contribution guidelines",
    "Identify relevant files",
    "Reproduce the behavior",
    "Review the proposed change",
    "Run relevant tests",
    "Review the diff",
    "Check formatting and linting",
    "Prepare a commit message",
    "Review the pull request draft",
  ]
  const [checks, setChecks] = useState(steps.map(() => false))
  const [diff, setDiff] = useState("")
  const [notice, setNotice] = useState("")
  const [title, setTitle] = useState(
    issue ? `fix: ${issue.title.toLowerCase()}` : "",
  )
  const [summary, setSummary] = useState(
    issue
      ? `Addresses #${issue.number}. Describe the implemented behavior and why this approach was chosen.`
      : "",
  )
  const [testing, setTesting] = useState(
    "List the exact commands, outcomes, exit codes, and any scenarios that were not run.",
  )
  if (!analysis) return null
  const changed = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map(
    (match) => match[2],
  )
  const additions = (diff.match(/^\+(?!\+\+)/gm) || []).length
  const deletions = (diff.match(/^-(?!---)/gm) || []).length
  const count = checks.filter(Boolean).length
  const guidelines = analysis.files.find((file) =>
    /(^|\/)(contributing\.md|contribution\.md)$/i.test(file.path),
  )?.path
  const announce = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(""), 2200)
  }
  const markdown = `# ${title}\n\n## Problem\n${
    issue
      ? `Closes #${issue.number}: ${issue.title}`
      : "Describe the linked issue."
  }\n\n## Implementation\n${summary}\n\n## Testing\n${testing}\n`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown)
      announce("Pull request markdown copied")
    } catch {
      announce("Clipboard permission was denied")
    }
  }
  return (
    <div className="page guide-page">
      <div className="page-title compact">
        <div>
          <p>CONTRIBUTION PREPARATION</p>
          <h1>Review real evidence before proposing a change</h1>
          <span>
            {issue
              ? `Based on live GitHub issue #${issue.number}`
              : "Select an issue to link repository evidence."}
          </span>
        </div>
        {issue && (
          <a
            className="button secondary"
            href={issue.htmlUrl}
            target="_blank"
            rel="noreferrer"
          >
            Issue #{issue.number} ↗
          </a>
        )}
      </div>
      {notice && (
        <div className="inline-notice">
          <Icon name="check" size={14} />
          {notice}
        </div>
      )}
      <div className="guide-progress">
        <div>
          <span>Contributor-confirmed readiness</span>
          <b>
            {count} of {steps.length} steps
          </b>
        </div>
        <div>
          <i style={{ width: `${count * 10}%` }} />
        </div>
      </div>
      <div className="guide-layout">
        <section className="panel checklist">
          <div className="panel-head">
            <div>
              <h2>First contribution checklist</h2>
              <p>You—not the AI—confirm each completed step</p>
            </div>
          </div>
          {steps.map((step, i) => (
            <button
              key={step}
              onClick={() =>
                setChecks((values) =>
                  values.map((value, index) => (index === i ? !value : value)),
                )
              }
              className={checks[i] ? "done" : i === count ? "current" : ""}
            >
              <span>{checks[i] ? <Icon name="check" size={14} /> : i + 1}</span>
              <div>
                <b>{step}</b>
                <small>
                  {checks[i]
                    ? "Contributor confirmed"
                    : i === 1 && guidelines
                      ? guidelines
                      : "Not confirmed"}
                </small>
              </div>
            </button>
          ))}
        </section>
        <section className="guide-main">
          <div className="panel diff-input">
            <div className="panel-head">
              <div>
                <h2>Change review</h2>
                <p>
                  Paste a real unified diff from <code>git diff</code>
                </p>
              </div>
              {diff && <Badge tone="green">PARSED</Badge>}
            </div>
            <textarea
              value={diff}
              onChange={(e) => setDiff(e.target.value)}
              placeholder={
                "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ ..."
              }
            />
            {diff ? (
              <>
                <div className="diff-summary">
                  <div>
                    <b>{changed.length}</b>
                    <span>Changed files</span>
                  </div>
                  <div>
                    <b>+{additions}</b>
                    <span>Additions</span>
                  </div>
                  <div>
                    <b>−{deletions}</b>
                    <span>Deletions</span>
                  </div>
                </div>
                <div className="parsed-files">
                  {changed.map((path) => (
                    <div key={path}>
                      <Icon name="file" />
                      <span>{path}</span>
                      <Badge
                        tone={
                          analysis.testFiles.includes(path)
                            ? "green"
                            : "neutral"
                        }
                      >
                        {analysis.testFiles.includes(path) ? "TEST" : "SOURCE"}
                      </Badge>
                    </div>
                  ))}
                </div>
                <pre className="diff-view">{diff}</pre>
              </>
            ) : (
              <div className="empty-card">
                No change data has been supplied. DevPilot will not invent
                changed files.
              </div>
            )}
          </div>
          <div className="panel evidence-summary">
            <div className="panel-head">
              <div>
                <h2>Evidence boundaries</h2>
                <p>
                  Keep repository facts, contributor review, and execution
                  results distinct
                </p>
              </div>
            </div>
            <div className="state-columns">
              <div>
                <Badge tone="green">REPOSITORY FACT</Badge>
                <b>{analysis.files.length} Git entries indexed</b>
                <small>{analysis.repo.fullName}</small>
              </div>
              <div>
                <Badge tone={diff ? "amber" : "neutral"}>
                  CONTRIBUTOR INPUT
                </Badge>
                <b>
                  {diff
                    ? `${changed.length} changed files supplied`
                    : "No diff supplied"}
                </b>
                <small>Review required</small>
              </div>
              <div>
                <Badge tone="neutral">TEST EVIDENCE</Badge>
                <b>Not shared automatically</b>
                <small>Record exact output in the draft</small>
              </div>
            </div>
          </div>
          <div className="panel pr-draft">
            <div className="panel-head">
              <div>
                <h2>Pull request draft</h2>
                <p>
                  Editable · prepared from the selected issue and contributor
                  evidence
                </p>
              </div>
              <Badge tone="purple">DRAFT</Badge>
            </div>
            <label>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
            <label>Implementation summary</label>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
            <label>Testing evidence</label>
            <textarea
              value={testing}
              onChange={(e) => setTesting(e.target.value)}
            />
            <div className="draft-actions">
              <Button kind="secondary" onClick={copy}>
                Copy markdown
              </Button>
              <a
                className="button primary"
                href={`${analysis.repo.htmlUrl}/compare/${analysis.repo.defaultBranch}...${analysis.repo.defaultBranch}?expand=1`}
                target="_blank"
                rel="noreferrer"
              >
                Open GitHub compare ↗
              </a>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(() =>
    new URLSearchParams(window.location.search).has("github")
      ? "connect"
      : "landing",
  )
  const [analysis, setAnalysis] = useState<ProjectAnalysis | null>(null)
  const [issues, setIssues] = useState<GitHubIssue[]>([])
  const [selectedIssue, setSelectedIssue] = useState<GitHubIssue | null>(null)
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null)
  const [accountLoading, setAccountLoading] = useState(true)
  const go = (s: Screen) => {
    setScreen(
      s !== "landing" && s !== "auth" && !firebaseUser ? "auth" : s,
    )
    window.scrollTo({ top: 0, behavior: "smooth" })
  }
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("github")) {
      window.history.replaceState({}, "", window.location.pathname)
    }
  }, [])
  useEffect(() => {
    if (!firebaseAuth) {
      setAccountLoading(false)
      return
    }
    return onAuthStateChanged(firebaseAuth, (user) => {
      setFirebaseUser(user)
      setAccountLoading(false)
      if (user && screen === "auth") setScreen("connect")
    })
  }, [screen])
  const workspace = useMemo(
    () => ({
      analysis,
      setAnalysis,
      issues,
      setIssues,
      selectedIssue,
      setSelectedIssue,
    }),
    [analysis, issues, selectedIssue],
  )
  let content: ReactNode
  if (accountLoading) content = <div className="app-loading"><i className="spinner"/>Loading account…</div>
  else if (screen === "landing") content = <Landing go={go} />
  else if (screen === "auth" || !firebaseUser) content = <Auth go={go} />
  else if (screen === "connect" || !analysis) content = <Connect go={go} />
  else
    content = (
      <Shell screen={screen} go={go}>
        {screen === "dashboard" ? (
          <LiveDashboard go={go} />
        ) : screen === "explorer" ? (
          <LiveExplorer go={go} />
        ) : screen === "issues" ? (
          <LiveIssues go={go} />
        ) : screen === "tests" ? (
          <RealTestLab go={go} />
        ) : screen === "guide" ? (
          <LiveContributionGuide />
        ) : (
          <LiveSettings go={go} />
        )}
      </Shell>
    )
  return (
    <WorkspaceContext.Provider value={workspace}>
      {content}
    </WorkspaceContext.Provider>
  )
}
