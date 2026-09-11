# MAM — Simple Getting Started Guide

A plain-language guide to running and using the MAM application. No deep
technical knowledge needed. Just follow the steps in order.

---

## What is this app? (Question 5)

**MAM** stands for **Media Asset Management**. Think of it as a private,
organized library for a newsroom's video and media files.

Instead of staff emailing huge video files around or losing them on random
shared drives, everything lives in one organized place where you can:

- **Upload** video and media files (news packages, interviews, raw footage).
- **Add information** to each file — what programme it's for, which bureau
  shot it, the story type, air date, rights/licensing details, and so on.
- **Search and filter** to find any clip quickly.
- **Route files through an approval process** — a producer submits a clip,
  an editor reviews and approves or rejects it.
- **Archive** old approved clips into "cold storage" to keep the active
  library tidy, and restore them later if needed.

### What makes it special

- **Built for broadcast newsrooms**, not a generic file store. It uses real
  newsroom language (programme, bureau, story type, air date, rights window).
- **Automatic video processing.** When you upload a video, the system
  automatically makes a smaller preview version and thumbnail images so you
  can watch/preview without downloading the huge original.
- **Approval workflow built in.** Content moves through Draft → Quality
  Check → Editorial Approval → Approved, with a clear record of who did what.
- **Roles and permissions.** Producers, editors, and archivists each see and
  do only what their job needs. These rules are enforced by the system, not
  just hidden in the screen — so they can't be worked around.
- **Runs on your own computers/servers.** No monthly cloud subscription
  required; the organization keeps full control of its media.

---

## The five roles (people who use it)

| Role | What they do |
|------|--------------|
| **Administrator** | The "super user." Can do everything, manage users. |
| **Producer** | Uploads clips, fills in details, submits them for review. |
| **Editor** | Reviews submitted clips and approves or rejects them. |
| **Archivist** | Moves approved clips to cold storage and restores them. |

---

## 1. How to run the application

The app has two parts that both need to be running:

1. **The backend** (the engine + database, runs inside Docker).
2. **The frontend** (the website you actually click around in).

### Step 1 — Start the backend

Open PowerShell and run these two lines:

```powershell
cd D:\MaM\mam-platform
docker compose --env-file .env.smoke -f compose.smoke.yaml up -d
```

Wait 2–5 minutes the first time (it's starting up the engine). Check it's
ready:

```powershell
docker compose -f compose.smoke.yaml ps
```

When you see `mam-smoke-nuxeo` marked **healthy**, the backend is ready.

> **Tip:** You only need to do this once per work session. If your computer
> was restarted, run the `up -d` command again.

### Step 2 — Start the frontend

Open a **second** PowerShell window and run:

```powershell
cd D:\MaM\mam-web
npm run dev
```

It will print a web address, usually:

```
➜  Local:   http://localhost:5173/
```

### Step 3 — Open it in your browser

Go to **http://localhost:5173**

> **Important:** Use the exact address the terminal printed. If something
> else was already using 5173, it may pick `5174` instead — always check the
> terminal line that says "Local:". Using the wrong port is the #1 cause of
> a "Could not reach the backend" error on the login screen.

You'll see a **Sign in** page. That means everything is working.

---

## 2. How to create users

There are already 4 ready-to-use accounts for testing:

| Username | Password | Role |
|----------|----------|------|
| `Administrator` | `Administrator` | Administrator (full access) |
| `mam_producer1` | `Producer!2026` | Producer |
| `mam_editor1` | `Editor!2026` | Editor |
| `mam_archivist1` | `Archivist!2026` | Archivist |

Just type one of these into the Sign in page to start.

### If you need to create MORE users

Right now there is **no "Add User" screen inside the app** — users are
created behind the scenes. The simplest way:

**Ask me (or run a short script) to create them**

Tell me the usernames and which role each should have, and I'll create them
in one step. Under the hood this uses the system's user API to make the
account and put it in the right group (`mam-producers`, `mam-editors`, or
`mam-archivists`) — the group is what decides what the person is allowed to
do.

> **Heads-up:** In this simple local test setup, the engine's own visual
> admin screen (the full "Nuxeo Web UI") is **not installed**, so there
> isn't a click-through user-management page available here. User management
> is done via the API for now.

> **Should we plan something better?** Yes — a proper "Manage Users" screen
> inside our own app would be a good future addition, so an administrator can
> add people without leaving the app or running anything. Tell me if you want
> this built and I'll plan it out.

---

## 3. What you can do as an administrator

An **Administrator** account can do everything a producer, editor, and
archivist can do, all in one login — plus behind-the-scenes management like
creating users and assigning roles.

In this simple local test setup, there is **no separate visual admin
dashboard** (the engine's full admin UI isn't installed here). So as an
administrator you have two things available:

1. **Our own app** at **http://localhost:5173** — sign in as `Administrator`
   and you can upload, review, approve, archive, and search everything,
   because an admin bypasses all the role restrictions.
2. **Behind-the-scenes management** (creating users, assigning roles,
   rebuilding the search index) — done via the system API. Ask me to run
   these for you, or see section 2 for user creation.

> In a full production deployment, a richer visual admin dashboard can be
> added. For local testing, the app itself plus the occasional script covers
> everything you need.

---

## 4. Where is everything stored?

Everything you upload and enter is saved **on your own machine**, inside
Docker's managed storage (called "volumes"). Nothing goes to the public
internet or a third-party cloud in this local setup.

Three things are stored:

| What | Where it lives | Plain meaning |
|------|----------------|----------------|
| The actual video/media files | `mam-smoke-nuxeo-data` volume | The big original files you upload |
| The information about each file (title, programme, status…) | Same volume (database) | The "index card" details for each file |
| Logs | `mam-smoke-nuxeo-logs` volume | Diagnostic records, for troubleshooting |

Key points in plain terms:

- **Your data survives restarts.** Stopping the app or rebooting your
  computer does **not** delete anything.
- **Data is only wiped if you explicitly ask for it** — specifically, using
  the `down -v` command (the `-v` means "also delete the stored data"). The
  plain `down` command stops the app but keeps everything.
- **In a real production deployment**, the media files can instead be sent to
  proper cloud/object storage (S3 or MinIO) for scale and durability. That's
  already supported by the project — this simple local setup just keeps
  things on your disk so you don't need to configure storage to test.

### Do I need to configure storage to use it?

**No.** For local testing, storage works out of the box — just upload files
and they're saved automatically. You only configure external storage (S3/
MinIO) when deploying for real, and that's a separate deployment step.

---

## 5. A complete end-to-end test (try the whole thing)

This walks one clip through the entire newsroom process, switching roles as
you go. Sign out and back in between roles using the **Sign out** button in
the top-right.

**As a Producer** (`mam_producer1` / `Producer!2026`)
1. Open **http://localhost:5173** and sign in.
2. Click **Upload media** in the left menu.
3. Drag in a video (or any file), give it a **Title**, fill in a few details
   like Programme and Story type, then click **Upload asset**.
4. You'll be taken to the clip's detail page. Click **Submit for review**.

**As an Editor** (`mam_editor1` / `Editor!2026`)
5. Sign out, sign back in as the editor.
6. Click **Review queue** — your submitted clip is waiting there.
7. Review it, then **Approve** (or **Reject** with a reason).

**As an Archivist** (`mam_archivist1` / `Archivist!2026`)
8. Sign out, sign back in as the archivist.
9. Click **Archive** — only approved clips appear here.
10. Click **Archive** on the clip to move it to cold storage. A **Restore**
    button appears; click it to bring the clip back.

**Check search (any user)**
11. Click **Assets** to see all clips. Use the filter chips (story type,
    status, storage tier) to narrow the list.

That's the full lifecycle: **upload → review → approve → archive → restore**.

---

## Quick troubleshooting

| Problem | Fix |
|---------|-----|
| Login says "Could not reach the backend" | You're on the wrong port, or the backend isn't running. Use the exact "Local:" address from the terminal, and confirm the backend is `healthy`. |
| Sign in says "Invalid credentials" | Wrong username/password. Use one from the table in section 2. |
| A button is greyed out with a lock icon | Your current role isn't allowed to do that. Sign in as the right role. |
| Search finds nothing by typing text | Full-text typing search isn't available in this local test setup — use the filter chips instead. |
| Everything seems broken | Restart both parts: backend (`docker compose ... up -d`) and frontend (`npm run dev`). |

---

*For the deeper technical version of all this, see `mam-web/README.md`
(section "End-to-end testing") and the other documents in this `docs/`
folder.*
