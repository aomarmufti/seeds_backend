# Build a full app from scratch: database → backend → API → frontend

**Who this is for:** a complete beginner on a Mac. No prior knowledge assumed.
**Time:** about 60–90 minutes, in one sitting or several.
**What you'll have at the end:** a tiny "Seeds tutors" app that you built yourself, with four parts running on your own MacBook:

```
 Your browser                    Your Django                  Your PostgreSQL
 (frontend page,    ──HTTP──▶    program (backend,   ──SQL──▶  database
  port 3000)        ◀─JSON───    port 8000)          ◀─rows──  (port 5432)
```

You'll be able to point at each box, say what it does, and watch a message travel through all of them.

---

## How to use this guide

- Do the parts **in order**. Each part ends with a **✅ Checkpoint**: what you should see. If you see it, move on. If not, go to the **🔧 If something goes wrong** box right under it. There's also a big **Troubleshooting** table near the end.
- **Terminal** = the Mac app where you type commands (press `Cmd + Space`, type `Terminal`, press Enter).
- **Editor** = where you edit code files. Install **VS Code** (free): https://code.visualstudio.com
- When a code block starts with `bash` it's a command you type into **Terminal**, then press **Enter**. Don't type the `$`. Other code blocks are file contents.
- A finished, tested copy of everything lives in `learn/seeds-mini-reference/`. If you ever get lost, compare your file with the one there.
- **You will use two different kinds of window. Mixing them up is the #1 beginner mistake:**

  | | **Database window** | **Normal Terminal** |
  |---|---|---|
  | How to open | Double-click a database in the **Postgres app** | `Cmd + Space`, type `Terminal`, Enter |
  | Prompt looks like | `seeds_mini=#` (ends in `#`) | `azeemmufti@MacBook ~ %` (ends in `%`) |
  | You type | **SQL** (`CREATE DATABASE ...;`, `SELECT ...;`) | **commands** (`cd`, `python3`, `pip`, `python manage.py`) |
  | To leave it | `\q` then Enter | just close it |

  If you type a command like `cd` or `python3` after a prompt ending in `#`, nothing useful happens. Each part below says which window to use.
- **Errors are normal.** Every developer sees them all day. An error message is the computer telling you exactly what it needs. Read the **last line** first.

### The five words you asked about, in one place

| Word | Plain meaning |
|---|---|
| **Server** | A program that waits for requests and answers them. (Also used for the computer it runs on.) Here, "the server" = Django running on your Mac. |
| **Website address (URL)** | Where to send a request. `http://localhost:8000/api/tutors/` = *this computer* (`localhost`), *door number* 8000 (the port), *room* `/api/tutors/` (the path). |
| **HTTP** | The rules of the conversation. The browser sends a **request** (a method like GET or POST, plus an address); the server sends a **response** (a status number like 200 plus data). HTTPS is the same but encrypted. |
| **API** | The list of requests the server understands, meant for other *programs* (not people). Ours will have `GET /api/tutors/` ("list tutors") and `POST /api/tutors/` ("add a tutor"). |
| **Django** | A Python toolkit for writing the server program, so you don't build everything by hand. |

---

## Part 0: Check your tools (10 min)

Open **Terminal** and run each of these.

**1. Python (must be 3.10 or newer):**
```bash
python3 --version
```
✅ Something like `Python 3.12.4`.

> 🔧 **A pop-up says "command line developer tools are required"** → click **Install**, wait until it finishes, run the command again.
> 🔧 **It says 3.9.x or lower** → download the macOS installer from https://www.python.org/downloads/ , install it, **close Terminal completely, reopen it**, run again.

**2. Your Mac username** (we need it later):
```bash
whoami
```
✅ Prints something like `azeemmufti`. Write it down. When this guide says `azeemmufti`, use what **your** `whoami` printed if it's different.

**3. PostgreSQL is running.** Open the **Postgres** app. You should see the blue elephant, a green **Running**, and **Port 5432**, like your screenshot.

> 🔧 **It says "Stopped"** → click **Start**.
> 🔧 **Port isn't 5432** → remember the number; you'll type it in Part 4.

---

## Part 1: Create the empty database (5 min)

**Idea:** Postgres is one program that can hold many separate **databases**, like one filing cabinet with many drawers. We'll make a new drawer for this project so it doesn't mix with your practice table.

1. In the Postgres app window, **double-click the `azeemmufti` database icon**. This opens the **database window**, already connected. The prompt looks like `azeemmufti=#`. (It only understands SQL.)
2. Type this (the `;` at the end matters) and press Enter:

```sql
CREATE DATABASE seeds_mini;
```

✅ **Checkpoint:** it prints `CREATE DATABASE`.

Check it exists:
```sql
\l
```
You should see `seeds_mini` in the list. Press `q` if it asks you to scroll. When you're done, type `\q` and press Enter to leave it, then close the window. **From Part 2 onwards you use a normal Terminal**, so don't keep typing into this one.

> 🔧 **`ERROR: database "seeds_mini" already exists`** → fine, you did this already. Move on.
> 🔧 **Nothing happens after pressing Enter / prompt shows `azeemmufti-#`** → you forgot the `;`. Type `;` and press Enter.

---

## Part 2: Make a project folder and a Python "bubble" (10 min)

> ⚠️ **Use a normal Terminal for this part** (`Cmd + Space` → `Terminal`), **not** the database window from Part 1. Check the prompt ends in `%`, not `#`.

**Idea:** Python projects each get their own **virtual environment** (a "bubble"). Packages you install go inside the bubble, so projects can't break each other.

In **Terminal**:

```bash
mkdir ~/seeds-mini
cd ~/seeds-mini
python3 -m venv venv
source venv/bin/activate
```

✅ **Checkpoint:** your prompt now starts with `(venv)`. That means the bubble is active. **Every time you open a new Terminal window for this project, you must run `cd ~/seeds-mini` and `source venv/bin/activate` again.**

Now install the three tools we need:

```bash
pip install "django>=5.2,<5.3" "psycopg[binary]" django-cors-headers
```

What they are:
- **django**: the toolkit for the backend
- **psycopg**: lets Python talk to PostgreSQL
- **django-cors-headers**: we'll need this in Part 9. Installing now saves a step.

✅ **Checkpoint:** run `pip list`. You should see `Django 5.2.x`, `psycopg`, `django-cors-headers`.

> 🔧 **`zsh: no matches found: psycopg[binary]`** → you left out the quote marks. Copy the command exactly, with the quotes.
> 🔧 **`No matching distribution found for Django>=5.2`** → your Python is too old. Go back to Part 0 and install a newer Python, then delete the bubble (`rm -rf venv`) and redo Part 2.
> 🔧 **`pip: command not found`** → the bubble isn't active. Run `source venv/bin/activate` (you need `(venv)` in the prompt).
> 🔧 **A red error mentioning `pg_config` or "building wheel" for psycopg** → you typed `psycopg` without `[binary]`. Run the install command above exactly.

---

## Part 3: Create the Django project (5 min)

Still in Terminal, still in `~/seeds-mini` with `(venv)` showing:

```bash
django-admin startproject config .
python manage.py startapp tutors
```

⚠️ **Don't forget the `.` (dot)** after `config`. It means "here".

What you just made:
- `config/` = the project's **settings** and **address book** (`urls.py`)
- `tutors/` = an **app**: one area of functionality. Ours handles tutors.
- `manage.py` = the control panel for the project. You'll run `python manage.py ...` a lot.

Open the folder in VS Code:
```bash
code .
```

> 🔧 **`code: command not found`** → open VS Code yourself, choose **File → Open Folder…**, pick `seeds-mini` in your home folder.
> 🔧 **`django-admin: command not found`** → bubble not active (`source venv/bin/activate`) or Django didn't install (redo Part 2).
> 🔧 **You forgot the dot and now there's a `config/config/` folder** → run `rm -rf config manage.py` then repeat the first command above **with the dot**.

✅ **Checkpoint:** in VS Code's left sidebar you see `config`, `tutors`, `manage.py`, `venv`.

---

## Part 4: Connect Django to your database (10 min)

Open **`config/settings.py`** in VS Code. It's long. We make **four small edits**.

**Edit 1.** Find `INSTALLED_APPS`. Add `"tutors",` as the last item (keep the comma!):

```python
INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "tutors",
]
```

**Edit 2.** Find `DATABASES = {...}` (it mentions `sqlite3`). **Replace the whole block** with this. Change `azeemmufti` if your `whoami` was different, and `5432` if your Postgres port was different:

```python
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": "seeds_mini",
        "USER": "azeemmufti",
        "PASSWORD": "",
        "HOST": "localhost",
        "PORT": "5432",
    }
}
```

**Edit 3.** Find `TIME_ZONE = "UTC"` and change it to:

```python
TIME_ZONE = "Europe/London"
```

**Edit 4.** Scroll to the **very bottom** and add this line:

```python
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
```

Save with `Cmd + S`. Then test:

```bash
python manage.py check
```

✅ **Checkpoint:** `System check identified no issues (0 silenced).`

> 🔧 **`SyntaxError` and a line number** → you probably deleted a comma or bracket. Open that line in `settings.py` and compare with the blocks above.
> 🔧 **`ModuleNotFoundError: No module named 'psycopg'`** → bubble not active, or redo the `pip install` in Part 2.

---

## Part 5: Describe your data (the model) and build the table (10 min)

**Idea:** In Django you describe a table as a Python **class**, called a **model**. Django turns it into a real table in Postgres. You never write `CREATE TABLE` yourself.

Open **`tutors/models.py`** and replace everything with:

```python
from django.db import models


class Tutor(models.Model):
    name = models.CharField(max_length=100)
    subject = models.CharField(max_length=100)

    def __str__(self):
        return f"{self.name} ({self.subject})"
```

Read it: a `Tutor` has a `name` and a `subject`, both short text. Save it.

Now two commands. The first *writes a plan* (a **migration**); the second *runs the plan* against Postgres:

```bash
python manage.py makemigrations tutors
python manage.py migrate
```

✅ **Checkpoint:**
- First command prints `+ Create model Tutor`.
- Second prints a list of `Applying ... OK` lines, ending with `Applying tutors.0001_initial... OK`.

**Now go and look at the real table.** In the Postgres app, double-click the **`seeds_mini`** database icon (if it doesn't appear, click away and back, or use the `azeemmufti` one and type `\c seeds_mini`). Then:

```sql
\dt
\d tutors_tutor
SELECT * FROM tutors_tutor;
```

✅ You'll see a list of tables including `tutors_tutor`, its columns (`id`, `name`, `subject`), and `(0 rows)`. **That's a table you defined in Python.**

> 🔧 **`No changes detected`** after `makemigrations` → `"tutors"` isn't in `INSTALLED_APPS` (Edit 1) or you didn't save `models.py`.
> 🔧 **`connection refused` / `could not connect to server`** → Postgres isn't running. Open the Postgres app, click **Start**. If it is running, check the port in Edit 2.
> 🔧 **`role "xxxx" does not exist`** → the `USER` in settings doesn't match your Mac username. Run `whoami` and fix `USER`.
> 🔧 **`database "seeds_mini" does not exist`** → redo Part 1.
> 🔧 **`password authentication failed`** → rare with the Postgres app. Make sure `"PASSWORD": ""` is empty, and `HOST` is `"localhost"`.
> 🔧 **`relation "tutors_tutor" does not exist` later on** → you skipped `python manage.py migrate`.

---

## Part 6: Start the server and add data through the admin site (10 min)

Django comes with a free back-office website. Register your model so it shows up. Open **`tutors/admin.py`**, replace everything with:

```python
from django.contrib import admin

from .models import Tutor

admin.site.register(Tutor)
```

Create your admin login (you invent these; it's only for your machine):

```bash
python manage.py createsuperuser
```
It asks for a username (e.g. `admin`), email (press Enter to skip) and password. **You won't see the password as you type it. That's normal.** If it warns the password is too simple, type `y` to continue; it's your local practice machine.

Start the server:

```bash
python manage.py runserver
```

✅ **Checkpoint:** it prints `Starting development server at http://127.0.0.1:8000/` and then **keeps running**. Terminal looks "stuck". That's right: the server is now alive and waiting for requests. **Leave this Terminal window alone.** We'll call it **Terminal 1**.

Open **http://localhost:8000/admin/** in your browser, log in, click **Tutors → Add**, create "Amina Rahman" / "Maths", and save.

Go back to the Postgres window and run:
```sql
SELECT * FROM tutors_tutor;
```
✅ **Your row is there.** You clicked a button on a web page, and a row appeared in a database. That's the whole backend idea.

> 🔧 **`Error: That port is already in use.`** → another server is on 8000. Stop it (`Ctrl + C` in its window), or find and stop it: `lsof -i :8000` then `kill <the PID number>`.
> 🔧 **`You have 18 unapplied migration(s)`** → you skipped `python manage.py migrate` in Part 5. Press `Ctrl + C`, run it, start the server again.
> 🔧 **Opening http://localhost:8000/ (no `/admin`) shows a 404 "Page not found"** → expected. We haven't defined anything at `/`. Use `/admin/` or `/api/tutors/`.
> 🔧 **Forgot admin password** → `Ctrl + C`, then `python manage.py changepassword yourusername`.

---

## Part 7: Build the API (20 min)

This is the part you said you struggled with, so slow down and read the comments.

An API endpoint is: **a URL + a function**. The URL says *where*; the function says *what to do*. Two files:

**File 1: `tutors/views.py`** (the functions). Replace everything with:

```python
import json

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

from .models import Tutor


@csrf_exempt  # lets our own frontend POST without a CSRF token (fine for learning)
def tutors(request):
    # --- GET /api/tutors/  ->  list every tutor -------------------------
    if request.method == "GET":
        rows = Tutor.objects.order_by("id").values("id", "name", "subject")
        return JsonResponse({"tutors": list(rows)})

    # --- POST /api/tutors/  ->  create one tutor ------------------------
    if request.method == "POST":
        try:
            body = json.loads(request.body)
        except json.JSONDecodeError:
            return JsonResponse({"error": "Body must be valid JSON"}, status=400)
        if not isinstance(body, dict):
            return JsonResponse({"error": "Body must be a JSON object"}, status=400)

        name = str(body.get("name", "")).strip()
        subject = str(body.get("subject", "")).strip()
        if not name or not subject:
            return JsonResponse({"error": "name and subject are required"}, status=400)

        tutor = Tutor.objects.create(name=name, subject=subject)
        return JsonResponse(
            {"id": tutor.id, "name": tutor.name, "subject": tutor.subject}, status=201
        )

    # --- anything else (PUT, DELETE...) ---------------------------------
    return JsonResponse({"error": "Method not allowed"}, status=405)
```

Read it top to bottom. The function does the same five things *every* API does:
1. **Look at the request** (what method? GET or POST?)
2. **Parse** the data the browser sent (`json.loads`)
3. **Validate** it (never trust what comes in)
4. **Talk to the database** (`Tutor.objects...`)
5. **Send a response**: data **plus a status code** (`200` ok, `201` created, `400` your input is wrong, `405` wrong method)

**File 2: `config/urls.py`** (the address book). Replace everything with:

```python
from django.contrib import admin
from django.urls import path

from tutors import views

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/tutors/", views.tutors),
]
```

This says: "if a request comes to `/api/tutors/`, run the `tutors` function."

Save both. Terminal 1 reloads itself automatically.

### Try it in your browser
Go to **http://localhost:8000/api/tutors/**.

✅ You see data, not a pretty page:
```
{"tutors": [{"id": 1, "name": "Amina Rahman", "subject": "Maths"}]}
```
That's **JSON**: the format programs use to exchange data. **You just called your own API.** (The browser sent a GET request.)

### Try POST (adding data) from a second Terminal
Browsers can't easily send POST from the address bar, so use `curl`, a tool that sends HTTP requests. Open a **new Terminal window** (`Cmd + N`), **Terminal 2**:

```bash
curl -i -X POST http://localhost:8000/api/tutors/ -H "Content-Type: application/json" -d '{"name":"Daniel Okafor","subject":"Physics"}'
```

✅ The first line is `HTTP/1.1 201 Created` and the end is `{"id": 2, "name": "Daniel Okafor", "subject": "Physics"}`. Refresh the browser tab: both tutors are listed.

Now **send bad data on purpose** and read the replies:

```bash
curl -i -X POST http://localhost:8000/api/tutors/ -H "Content-Type: application/json" -d '{"name":""}'
```
✅ `HTTP/1.1 400 Bad Request` and `{"error": "name and subject are required"}`

```bash
curl -i -X DELETE http://localhost:8000/api/tutors/
```
✅ `HTTP/1.1 405 Method Not Allowed`: we never built delete.

Look at **Terminal 1**. Every request is logged, e.g. `"POST /api/tutors/ HTTP/1.1" 201 56`. That's the server's diary.

> 🔧 **Browser shows a yellow Django error page** → read the **top line** (the exception type and message) and the **last file listed that is in your project** (not in `venv`). Common: `ImportError`/`NameError` = a typo; `ProgrammingError: relation does not exist` = run `migrate`.
> 🔧 **`curl: (7) Failed to connect`** → Terminal 1 isn't running the server. Start it again.
> 🔧 **`403 CSRF verification failed`** → the `@csrf_exempt` line above `def tutors` is missing from `views.py`.
> 🔧 **404 at `/api/tutors/`** → check `urls.py` exactly (including the trailing `/`).
> 🔧 **`curl` shows `Body must be valid JSON`** → quote marks got mangled. Use straight quotes `"` and wrap the JSON in single quotes `'...'` as shown. Don't paste from a rich-text app.

---

## Part 8: Build the frontend (15 min)

The **frontend** is what people actually see. In real products it's a separate program from the backend (Seeds' frontend is a Next.js app). We'll do the same: a plain web page, served on its own port.

In **Terminal 2** (new window → activate the bubble first):

```bash
cd ~/seeds-mini
source venv/bin/activate
mkdir frontend
```

In VS Code, create the file **`frontend/index.html`** (right-click `frontend` folder → New File) with this content:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Seeds Mini</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px; color: #1a1a1a; }
    li { padding: 6px 0; }
    input, button { font-size: 16px; padding: 8px; margin: 4px 0; }
    input { width: 100%; box-sizing: border-box; }
    button { cursor: pointer; }
    #message { color: #b00020; min-height: 1.5em; }
  </style>
</head>
<body>
  <h1>Seeds tutors</h1>
  <ul id="list"><li>Loading…</li></ul>

  <h2>Add a tutor</h2>
  <form id="form">
    <input id="name" placeholder="Name, e.g. Amina Rahman">
    <input id="subject" placeholder="Subject, e.g. Maths">
    <button type="submit">Add tutor</button>
  </form>
  <p id="message"></p>

  <script>
    // The address of the BACKEND. The page itself is served from a different
    // address (port 3000), so we have to say where the API lives.
    const API = "http://localhost:8000";

    const list = document.getElementById("list");
    const message = document.getElementById("message");

    // Ask the backend for all tutors and draw them.
    async function loadTutors() {
      const response = await fetch(`${API}/api/tutors/`);          // an HTTP GET request
      if (!response.ok) throw new Error(`Server answered ${response.status}`);
      const data = await response.json();                           // text -> JavaScript object

      list.innerHTML = "";
      if (data.tutors.length === 0) {
        list.innerHTML = "<li>No tutors yet. Add one below.</li>";
      }
      for (const tutor of data.tutors) {
        const li = document.createElement("li");
        li.textContent = `${tutor.name}: ${tutor.subject}`;         // textContent is safe from injected HTML
        list.appendChild(li);
      }
    }

    // When the form is submitted, send a POST request with JSON.
    document.getElementById("form").addEventListener("submit", async (event) => {
      event.preventDefault();                                       // stop the page reloading
      message.textContent = "";
      try {
        const response = await fetch(`${API}/api/tutors/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: document.getElementById("name").value,
            subject: document.getElementById("subject").value,
          }),
        });
        const data = await response.json();
        if (!response.ok) {                                         // 400 etc: show the server's reason
          message.textContent = data.error || `Server answered ${response.status}`;
          return;
        }
        event.target.reset();
        await loadTutors();                                         // refresh the list
      } catch (err) {
        message.textContent = "Could not reach the backend: " + err.message;
      }
    });

    loadTutors().catch((err) => {
      list.innerHTML = "";
      message.textContent = "Could not load tutors: " + err.message;
    });
  </script>
</body>
</html>
```

Look at the JavaScript at the bottom. `fetch(...)` is the browser sending an HTTP request to **your** API, exactly like `curl` did.

Serve the page (this is a second server, a tiny one that only hands out files):

```bash
cd frontend
python3 -m http.server 3000
```

Open **http://localhost:3000** in your browser.

### ⚠️ Expect this to fail. It's on purpose.

You'll see: **`Could not load tutors: Failed to fetch`**

Open the browser's developer tools: **`Cmd + Option + I`** → **Console** tab. You'll see a red message:

> `Access to fetch at 'http://localhost:8000/api/tutors/' from origin 'http://localhost:3000' has been blocked by CORS policy`

Every web developer meets this error. Part 9 explains and fixes it.

> 🔧 **`Address already in use` on port 3000** → use `3001` instead (`python3 -m http.server 3001`), visit `localhost:3001`, and remember to use `http://localhost:3001` in Part 9's `CORS_ALLOWED_ORIGINS`.
> 🔧 **Page is blank / just says "Loading…"** → open the Console (`Cmd + Option + I`). The red error tells you why. If the file is blank, check you saved `index.html`.

---

## Part 9: Fix the CORS error (10 min)

**What is happening:** your page lives at `localhost:3000`; your API lives at `localhost:8000`. To a browser those are **different "origins"**. By default a browser **refuses to let a page read data from a different origin**, to stop a malicious site from quietly reading your bank's pages while you're logged in. Your backend sees the request, answers it, **but the browser throws the answer away** because the backend didn't say "pages from `localhost:3000` are allowed". We must say it.

Open `config/settings.py` and make **three edits**:

**Edit 1.** Add `"corsheaders",` to `INSTALLED_APPS`:
```python
INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "corsheaders",
    "tutors",
]
```

**Edit 2.** Add this line at the **very top** of the `MIDDLEWARE` list (order matters):
```python
MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    ...the rest stays exactly as it was...
]
```

**Edit 3.** At the **bottom** of the file add (use `localhost`, not `127.0.0.1`, and no trailing slash):
```python
CORS_ALLOWED_ORIGINS = ["http://localhost:3000"]
```

Save. Terminal 1 reloads. **Refresh** http://localhost:3000 (`Cmd + R`).

✅ **Checkpoint:** you see your tutors listed. Type a name and subject, click **Add tutor**, and it appears. Click it with the fields empty and you see the server's message `name and subject are required` in red. Check Postgres: `SELECT * FROM tutors_tutor;` has the new rows.

![what you should see](images/frontend-after-add.png)

**🎉 You've built all four parts**: database, backend, API and frontend, and watched data flow through all of them.

> 🔧 **Still blocked after the fix** → (1) Is Terminal 1 still running with no red error after saving settings? A typo in settings stops the reload. (2) Did you use exactly `http://localhost:3000`, and open the page at `localhost:3000`, not `127.0.0.1:3000`? (3) Hard refresh: `Cmd + Shift + R`.
> 🔧 **`ModuleNotFoundError: No module named 'corsheaders'`** → bubble not active or the install in Part 2 didn't finish: `pip install django-cors-headers`.

---

## Part 10: Understand what just happened (15 min)

### Follow one click through the system

You click **Add tutor** with "Daniel Okafor" / "Physics":

1. **Browser JavaScript** runs `fetch("http://localhost:8000/api/tutors/", {method: "POST", body: ...})`.
2. Because the page and API are on different origins, the browser first sends a **preflight** request, `OPTIONS /api/tutors/`, which means "am I allowed to do this?". The CORS middleware answers "yes, from `localhost:3000`".
3. The browser then sends the real **`POST /api/tutors/`** with the JSON.
4. **Django** receives it. `config/urls.py` matches the path → runs `tutors()` in `views.py`.
5. The view **parses and validates** the JSON, then calls `Tutor.objects.create(...)`.
6. Django's **ORM** turns that into SQL (`INSERT INTO tutors_tutor ...`) and sends it to **PostgreSQL** on port 5432.
7. Postgres stores the row and answers. The view returns `201 Created` + JSON.
8. The page then sends `GET /api/tutors/` to refresh the list, and redraws it.

**See it yourself:** in Terminal 1 you'll see exactly these lines:
```
"OPTIONS /api/tutors/ HTTP/1.1" 200 0
"POST /api/tutors/ HTTP/1.1" 201 56
"GET /api/tutors/ HTTP/1.1" 200 125
```
And in the browser: **`Cmd + Option + I` → Network tab**, add a tutor, and click each request to see its headers, body and response.

### Break it on purpose (this is how you really learn)

| Experiment | What you'll see | What it teaches |
|---|---|---|
| Visit `localhost:8000/nope/` | `404 Not Found` | The address book (`urls.py`) has no match |
| `curl -X DELETE localhost:8000/api/tutors/` | `405 Method Not Allowed` | Same URL, different method = different meaning |
| Submit the form with empty fields | red `name and subject are required` (`400`) | The server validates; the frontend only displays what it says |
| In the **Postgres app click Stop**, then refresh the page | page says `Could not load tutors: Server answered 500`; Terminal 1 shows `OperationalError` / connection refused | `500` = the server broke. Here the **database was down**. Click **Start** and refresh: it recovers |
| Stop Terminal 1 (`Ctrl + C`), refresh the page | `Failed to fetch` | Nothing is listening on port 8000: the backend is the "kitchen", and it's closed |
| In `views.py` change the text `name and subject are required` to something else, save, then submit the empty form | Terminal 1 prints a line ending in `changed, reloading.`, and your new message appears | `runserver` watches your files in development, so you can edit and retry instantly |

**Status codes cheat sheet:** `2xx` = worked · `4xx` = *you* (the caller) sent something wrong · `5xx` = *we* (the server) broke.

### What "API" really means now

Your API is just the list of (method + path) pairs the server answers, with the data shapes it accepts and returns:

| Request | Meaning | Success |
|---|---|---|
| `GET /api/tutors/` | list tutors | `200` + `{"tutors": [...]}` |
| `POST /api/tutors/` + `{"name","subject"}` | add a tutor | `201` + the new tutor |

When you hear "REST API", it's this style: nouns in the URL (`/tutors/`), the HTTP method as the verb. "GraphQL" is a different style: one URL, and the client sends a query describing exactly the fields it wants. Same server, same database, different front door.

---

## Part 11: Starting again tomorrow (cheat sheet)

Everything stops when you close Terminal or shut the Mac. To restart:

1. **Postgres app**: make sure it says Running.
2. **Terminal 1 (backend):**
```bash
cd ~/seeds-mini
source venv/bin/activate
python manage.py runserver
```
3. **Terminal 2 (frontend):**
```bash
cd ~/seeds-mini/frontend
python3 -m http.server 3000
```
4. Browser: **http://localhost:3000**

To stop a server: click its Terminal window and press `Ctrl + C`.

Your **data survives** restarts: it's in Postgres, not in the Django program.

---

## Troubleshooting (find your symptom)

| You see | Cause | Fix |
|---|---|---|
| Typed commands and **nothing happens**; prompt looks like `seeds_mini=#` or `seeds_mini-#` | You're in the **database window** (SQL only) | Type `\q` + Enter to leave it, then open a **normal Terminal** (`Cmd + Space` → `Terminal`) |
| `command not found: python3` | Python missing | Install from python.org (Part 0) |
| `command not found: django-admin`, `pip`, or `ModuleNotFoundError` | The bubble (venv) isn't active | `cd ~/seeds-mini && source venv/bin/activate`. Prompt must show `(venv)` |
| `zsh: no matches found: ...[binary]` | Missing quotes | Use the exact install command with quotes |
| `No matching distribution found for Django` | Python older than 3.10 | Install newer Python, recreate venv |
| `could not connect to server` / `connection refused` | Postgres not running or wrong port | Postgres app → Start; check `PORT` in settings |
| `role "..." does not exist` | `USER` in settings ≠ Mac username | `whoami`, then fix `USER` |
| `database "seeds_mini" does not exist` | Part 1 skipped | `CREATE DATABASE seeds_mini;` |
| `relation "tutors_tutor" does not exist` | Table not built | `python manage.py migrate` |
| `No changes detected` on makemigrations | App not registered / file not saved | Check `"tutors"` in `INSTALLED_APPS`; save `models.py` |
| `You have N unapplied migration(s)` | Skipped migrate | `python manage.py migrate` |
| `That port is already in use` | Old server still running | `Ctrl + C` in the old window, or `lsof -i :8000` then `kill <PID>` |
| Browser: `Failed to fetch` | Backend not running **or** CORS not fixed | Is Terminal 1 running? Console message mentions CORS → Part 9 |
| Console: `blocked by CORS policy` | Origin not allowed | Part 9; origin must exactly equal the page address |
| `403 CSRF verification failed` on POST | `@csrf_exempt` missing | Restore it above `def tutors` |
| `405 Method Not Allowed` | Used a method the view doesn't handle | Intentional for DELETE/PUT |
| `400 Bad Request` | You sent invalid data | Read the `error` text in the response body |
| `500 Server error` | A bug or database problem on the server | Read Terminal 1: the **last lines** name the cause |
| `SyntaxError` / `IndentationError` | Typo; Python cares about spaces | Compare with `learn/seeds-mini-reference/` |
| Changed `index.html`, no change on screen | Browser cached it | `Cmd + Shift + R` |
| Changed Python, no change | Server crashed after a typo | Look at Terminal 1 for a red error; fix; it restarts itself |
| Everything is a mess | | Compare your files to `learn/seeds-mini-reference/`, or delete `~/seeds-mini` and redo from Part 2 (your database is untouched) |

**How to read any Python error:** read the **last line** (what went wrong), then scan upward for the **last file path that is inside your project** (not `venv/`). That's the line to look at.

---

## Glossary

- **Backend**: the program that holds the rules and talks to the database. Users never see it directly.
- **Frontend**: what users see and click (the web page).
- **Database / PostgreSQL**: permanent storage, organised in tables.
- **Table, row, column**: like a spreadsheet: a sheet, a line, a heading.
- **SQL**: the language for talking to a database (`SELECT`, `INSERT`).
- **Django**: Python toolkit for the backend.
- **Model**: a Python class that describes a table.
- **Migration**: a recorded, step-by-step change to the database structure.
- **ORM**: translates Python (`Tutor.objects.create(...)`) into SQL for you.
- **View**: a function that receives a request and returns a response.
- **URL / path / route**: the address a request is sent to; the path is the part after the port.
- **Port**: a numbered door on your computer. 5432 = Postgres, 8000 = Django, 3000 = frontend.
- **localhost**: "this computer".
- **HTTP request / response**: the question and the answer.
- **Method**: GET (read), POST (create), PUT/PATCH (change), DELETE (remove).
- **Status code**: the number that says how it went (200, 201, 400, 404, 500).
- **JSON**: the text format for sending data (`{"name": "Amina"}`).
- **API / REST**: the menu of requests a server answers; REST is the common style (nouns in URLs, methods as verbs).
- **CORS**: the browser rule that stops a page reading from a *different origin* unless the server allows it.
- **Virtual environment (venv)**: the project's private bubble of Python packages.
- **Migration vs. makemigrations**: `makemigrations` writes the plan; `migrate` runs it.

---

## Where this connects to real work

- **Your real Seeds backend** (`api/*.js`) is the same shape: URL → function → database → JSON response. The functions are written in Node instead of Python, and Supabase supplies the Postgres.
- **Your real frontend** (`seeds-frontend/`) is this `index.html`, grown up: it uses the same `fetch(...)` call (see `lib/api.js`).
- **`django_seeds/`** in this repo is *this* app grown up: relations between tables (students ↔ bookings ↔ tutors), a database rule that prevents double bookings, login tokens, tests. Its `GUIDE.md` is the next read now that the basics are clear.
- **A CRM / billing system** is the same machine with more tables (customers, invoices, payments), stricter rules, and more checks.
- **Databricks** sits after Postgres: you copy the data out and analyse it there, so heavy reports don't slow the live app.

### Good next steps
1. Add a `Student` model and a `Booking` that links a student to a tutor. Make a migration and see the foreign key in Postgres.
2. Add `DELETE` to the API, and a delete button in the page.
3. Read `django_seeds/GUIDE.md`.
4. Ask for the next stage (login/security, payments and invoices, or analysing the data in Databricks).
