# MAM — New Machine Setup & Requirements

If you cloned this repo onto a fresh machine and **Maven fails with lots of
errors**, this document is for you. It explains *why* it fails and gives the
exact, ordered steps to fix it.

---

## TL;DR — why Maven fails on a fresh clone

This project is a Nuxeo **addon**. Its Maven parent POM is
`org.nuxeo:nuxeo-parent:2025.21-SNAPSHOT`, which is **not published to any
public Maven repository**. It only exists inside the Nuxeo source checkout
at `D:\MaM\nuxeo`.

**That `nuxeo/` folder is git-ignored** (see `.gitignore`), so it is **not on
GitHub**. A fresh `git clone` gives you everything except `nuxeo/`, `*.jar`,
`*.zip`, and `vendor-tmp/`. With no `nuxeo/` folder, Maven can't resolve the
parent POM or any `org.nuxeo:*` dependency — hence the flood of errors like:

```
Could not find artifact org.nuxeo:nuxeo-parent:pom:2025.21-SNAPSHOT
Non-resolvable parent POM ...
Could not resolve dependencies ... org.nuxeo.ecm.*
```

**The fix:** get the `nuxeo/` source onto the new machine and install its
POMs into that machine's local Maven repo (`~/.m2`) **once**. After that,
Maven builds normally.

---

## 1. Requirements (install these first)

| Tool | Version | Why | Check |
|---|---|---|---|
| **JDK** | **21** (Azul Zulu 21 recommended) | Nuxeo 2025 LTS + this addon compile on Java 21 | `java -version` |
| **Apache Maven** | **3.9.6+** (3.9.9 tested) | Builds the Java addon | `mvn -version` |
| **Docker Desktop** | 24.0+ with Compose v2 | Runs the backend stack (Nuxeo/Postgres/ES/MinIO) | `docker version` |
| **Node.js** | **20.x** | Builds/runs the `mam-web` frontend | `node -v` |
| **Git** | any recent | Clone + the Nuxeo source | `git --version` |

- Set **`JAVA_HOME`** to the JDK 21 install and make sure `java`/`mvn`/`node`/
  `docker` are all on `PATH`.
- On Windows, run the commands below in **PowerShell**.

> **Common first mistake:** having Java 17 (or 11) as the default. Nuxeo 2025
> needs Java 21. Confirm `mvn -version` reports "Java version: 21.x" — if it
> shows 17, Maven will fail confusingly even with everything else correct.

---

## 2. Get the Nuxeo source onto the new machine

The `D:\MaM\nuxeo` folder is the upstream Nuxeo 2025 LTS source checkout. It
is **read-only vendor code** — never edit it. Because it's git-ignored, you
must bring it over separately. Pick whichever is practical:

- **Option A (easiest): copy it from the original machine.** Copy the entire
  `D:\MaM\nuxeo` folder from the machine where the project already builds,
  onto the new machine at the same path (`D:\MaM\nuxeo`). A zip + copy is
  fine. This guarantees the exact same source/version.

- **Option B: clone it from Nuxeo.** Clone the Nuxeo platform source and check
  out the branch/tag matching `2025.21-SNAPSHOT`. This is larger and must
  match the exact version the addon's POMs reference; Option A is safer.

Verify it landed:

```powershell
Test-Path D:\MaM\nuxeo\pom.xml          # must be True
Test-Path D:\MaM\nuxeo\parent\pom.xml   # must be True
```

---

## 3. Seed the local Maven repo with Nuxeo's POMs (the key step)

This installs the Nuxeo parent POMs into `~/.m2` so the addon can find them.
Run **once** per machine (or after wiping `~/.m2`):

```powershell
cd D:\MaM\nuxeo
mvn -N -B -DskipTests install

cd D:\MaM\nuxeo\parent
mvn -N -B -DskipTests install
```

- `-N` = install only that POM, don't build the whole Nuxeo reactor.
- These commands write only under `~/.m2` and never modify the Nuxeo
  checkout.
- First run downloads Nuxeo's Maven dependencies from Nuxeo's public
  repository — this needs **internet access** and can take several minutes.

> If `mvn -N install` in `D:\MaM\nuxeo` itself fails to resolve
> `nuxeo-parent`, the addon references a parent that is deeper in the Nuxeo
> tree. In that case also run the install in whatever subdirectory contains
> the `nuxeo-parent` artifact (search: `Get-ChildItem D:\MaM\nuxeo -Recurse
> -Filter pom.xml | Select-String "<artifactId>nuxeo-parent"`), then retry.

---

## 4. Build the MAM addon

```powershell
cd D:\MaM\mam-platform

# First build must be online (seeds ~/.m2 with mam-core, and pulls addon deps):
mvn -B -DskipTests install
```

Expected artifacts:
- `mam-core/target/mam-core-1.0.0-SNAPSHOT.jar`
- `mam-package/target/mam-package-1.0.0-SNAPSHOT.zip`

After that first `install`, faster offline package builds work:

```powershell
mvn -q -pl mam-core,mam-security,mam-workflow,mam-package -am package -o -DskipTests
```

Run the unit tests to confirm the toolchain is healthy:

```powershell
mvn -pl mam-security -am test -o
```

Expect `Tests run: 11, Failures: 0, Errors: 0`.

---

## 5. Get the vendored Nuxeo marketplace packages (for the Docker build)

The Docker image installs three add-on packages that are **git-ignored**
(`*.zip`, `vendor-tmp/`), so a fresh clone won't have them:

```
mam-platform/vendor/nuxeo-search-client-opensearch1-package-2025.21-SNAPSHOT.zip
mam-platform/vendor/nuxeo-amazon-s3-package-2025.21-SNAPSHOT.zip
```

Get them one of two ways:

- **Option A (easiest): copy the `mam-platform/vendor/` folder** from the
  original machine to the same path on the new one.

- **Option B: rebuild them from the Nuxeo source** (only if you can't copy):
  ```powershell
  cd D:\MaM\nuxeo
  mvn -Pdistrib -pl packages/nuxeo-search-client-opensearch1-package -am -DskipTests install
  mvn -Pdistrib -pl packages/nuxeo-amazon-s3-package -am -DskipTests install
  ```
  Then copy each module's `target/*.zip` into `mam-platform/vendor/` with the
  filenames shown above.

Verify:

```powershell
Get-ChildItem D:\MaM\mam-platform\vendor\*.zip
```

---

## 6. Build the backend Docker image

```powershell
cd D:\MaM\mam-platform

docker build `
  -f Dockerfile.integration `
  -t mam-platform/nuxeo-integration:local `
  --build-arg PG_DB=mam_nuxeo `
  --build-arg PG_USER=mam_nuxeo `
  --build-arg PG_PASSWORD=mam_nuxeo_dev_only `
  --build-arg ES_INDEX_NAME=mam_nuxeo `
  --build-arg MINIO_ROOT_USER=mam_minio_admin `
  --build-arg MINIO_ROOT_PASSWORD=mam_minio_dev_only `
  --build-arg MAM_S3_BUCKET=mam-blobs `
  --build-arg MAM_S3_COLD_BUCKET=mam-blobs-cold `
  --build-arg MAM_SMOKE_JWT_SECRET=smoke-secret-for-dev-integration-testing-1234567890 `
  .
```

(This mirrors the compose build; `compose.integration.yaml` can also build it
via `docker compose ... build nuxeo`.)

---

## 7. Start the backend stack

```powershell
cd D:\MaM\mam-platform
docker compose --env-file .env.integration -f compose.integration.yaml up -d
```

Wait ~60–120s, then verify:

```powershell
curl.exe -s http://127.0.0.1:8081/nuxeo/runningstatus
```

Expect `{"runtimeStatus":"ok",...,"repositoryStatus":"ok",...}`.

> `.env.integration` is committed (dev-only dummy values). If it's missing,
> copy `.env.integration.example` to `.env.integration`.

---

## 8. Start the frontend

```powershell
cd D:\MaM\mam-web
npm install          # first time only (node_modules is git-ignored)
npm run dev
```

Open **http://localhost:5173** and sign in as `Administrator` /
`Administrator`.

- The dev server proxies API calls to the backend on **port 8081**. Confirm
  `mam-web/.env.local` has `VITE_NUXEO_PROXY_TARGET=http://127.0.0.1:8081`.
  (`.env.local` is committed here with dev-only values; if missing, copy
  `.env.example` to `.env.local` and set that line.)

---

## 9. Sanity checklist for the whole setup

- [ ] `java -version` → 21.x
- [ ] `mvn -version` → Maven 3.9.6+, Java 21
- [ ] `node -v` → 20.x
- [ ] `docker version` → Engine 24+, Compose v2
- [ ] `D:\MaM\nuxeo\pom.xml` exists
- [ ] Nuxeo POMs installed to `~/.m2` (step 3 succeeded)
- [ ] `mvn -B -DskipTests install` in `mam-platform` succeeds
- [ ] `mam-platform/vendor/*.zip` present (2 files)
- [ ] Docker image built
- [ ] `http://127.0.0.1:8081/nuxeo/runningstatus` returns ok
- [ ] `http://localhost:5173` loads and login works

---

## What each part is (quick mental model)

- **`D:\MaM\nuxeo`** — upstream Nuxeo platform source (vendor, read-only,
  git-ignored). Only needed at *build* time to provide the parent POMs and
  to rebuild the vendored packages. Not needed at runtime.
- **`D:\MaM\mam-platform`** — the MAM Java addon (our code): document types,
  search, security guards, workflow, cold-storage archive, GC. Built into
  `mam-package.zip`, baked into the Nuxeo Docker image.
- **`D:\MaM\mam-web`** — the React/Vite frontend.
- **`D:\MaM\deploy`** — the production Docker Compose stack + go-live docs
  (see `deploy/PRODUCTION-GO-LIVE-CHECKLIST.md`).

---

## Troubleshooting the Maven errors specifically

| Error text | Cause | Fix |
|---|---|---|
| `Could not find artifact org.nuxeo:nuxeo-parent:pom:2025.21-SNAPSHOT` | `nuxeo/` not present / POMs not installed | Do steps 2 + 3. |
| `Non-resolvable parent POM` | Same as above | Do steps 2 + 3. |
| `Could not resolve dependencies for ... org.nuxeo.ecm.*` | `~/.m2` not seeded, or offline before first online build | Run step 3, then step 4 **online** (no `-o`) once. |
| `Fatal error compiling: invalid target release: 21` | Wrong JDK (17/11) active | Install JDK 21, set `JAVA_HOME`, re-check `mvn -version`. |
| `docker build` fails at COPY of a `vendor/*.zip` | Vendored packages missing | Do step 5. |
| Frontend "Could not reach backend" | Backend down or wrong port | Confirm step 7 healthy; `.env.local` target = 8081. |

If you still get errors after step 3, paste the **first** Maven error block
(not the last) — the root cause is almost always the very first
"Could not resolve / Non-resolvable" line, and everything after it is
downstream noise.
