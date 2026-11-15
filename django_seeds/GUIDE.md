# Learn backend architecture by building Seeds' backend in Django

Goal: after this you can **draw the system on a whiteboard, run it, break it, and answer follow-up questions** about it, using the same stack as your CRM/billing work (Django + PostgreSQL, analysed in Databricks).

Everything below is real and runnable. The outputs shown were captured from this code, not invented.

---

## 0. Run it (10 minutes)

You need Python 3.11+ and PostgreSQL. Easiest Postgres: `docker run -e POSTGRES_PASSWORD=seeds -e POSTGRES_USER=seeds -e POSTGRES_DB=seeds_dev -p 5432:5432 postgres:16`

```bash
cd django_seeds
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python manage.py migrate        # runs the generated SQL against Postgres
python manage.py seed_demo      # demo tutors, students, an admin login
python manage.py test           # 8 tests, real Postgres, no mocks
python manage.py runserver      # http://localhost:8000
```

If your Postgres isn't on `localhost:5432`, set `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.

Then look at it with your own eyes:
- `http://localhost:8000/admin/` (admin / admin12345): a free back-office UI over your tables
- `http://localhost:8000/api/v1/`: DRF's browsable API (click around endpoints)
- `psql seeds_dev` then `\d bookings_booking`: the actual table Django built

---

## 1. The big picture: what happens when the frontend calls the backend

Your frontend does this today (`seeds-frontend/lib/api.js`):

```js
fetch(`${BACKEND}/api/bookings`, { method: 'POST', headers: {Authorization: 'Bearer …'}, body: JSON.stringify({...}) })
```

Here is the journey of that one request:

```
Browser (Next.js on Vercel)
   │  1. DNS: "api.seeds.com" -> IP address
   │  2. TCP + TLS handshake  (this is the "S" in HTTPS: encryption)
   │  3. Sends text:  POST /api/v1/bookings/ HTTP/1.1
   │                  Authorization: Token abc…
   │                  Content-Type: application/json
   │                  {"student":1,"tutor":1,"subject":"Maths","start_time":"…"}
   ▼
Web server process  (gunicorn in production / runserver in dev)
   │  Turns raw bytes into a Python HttpRequest object (WSGI standard)
   ▼
Middleware stack  (settings.MIDDLEWARE: security headers, CORS, sessions…)
   ▼
URL router  (config/urls.py)  "POST /api/v1/bookings/" -> BookingViewSet.create
   ▼
Authentication + Permission classes   -> 401 / 403 if rejected
   ▼
Serializer      parse JSON, validate fields, look up student & tutor   -> 400 if bad
   ▼
Service / business rules  (services.py: price comes from the SERVER)
   ▼
ORM  (models.py)   Booking.objects.create(...)  ->  INSERT INTO bookings_booking …
   ▼
PostgreSQL   enforces constraints (overlap, FK, NOT NULL)  -> error -> we map to 409
   ▼
Response: status code + JSON body travels back the same way
```

**Almost every backend question is "which box is this, and what does it do?"** The files map to the boxes:

| Box | File in `django_seeds/` |
|---|---|
| URL router | `config/urls.py` |
| Settings (DB, auth, middleware) | `config/settings.py` |
| View / viewset (handles the request) | `bookings/views.py` (and the bare version `views_raw.py`) |
| Serializer (JSON ⇄ objects, validation) | `bookings/serializers.py` |
| Business rules | `bookings/services.py` |
| Models (schema) | `bookings/models.py` |
| Migrations (schema history) | `bookings/migrations/` |

---

## 2. Anatomy of a REST API (answers your "domain, output, type of request" question)

A REST call has **four inputs** and **two outputs**.

**Inputs**
1. **Domain**: *where* (`https://api.seeds.com`). Finds the server.
2. **Path**: *what resource*: `/api/v1/bookings/`, or one record: `/api/v1/bookings/42/`. Nouns, plural.
3. **Method** (the "type of request"): *what to do to it*.

   | Method | Meaning | Example | Safe to repeat? |
   |---|---|---|---|
   | GET | read | list bookings | yes |
   | POST | create / trigger an action | create booking, `…/42/cancel/` | **no** (can duplicate) |
   | PUT / PATCH | replace / partially update | change a booking's subject | PUT yes |
   | DELETE | remove | | yes |

4. **Headers + body**: *who you are* (`Authorization`) and *the data* (JSON). Optional **query string** (`?tutor=1&status=confirmed`) is for filtering.

**Outputs**
5. **Status code**: the machine-readable verdict:
   `200` OK · `201` created · `400` your data is invalid · `401` who are you? · `403` I know you, not allowed · `404` not found · `409` conflict with current state · `500` our bug
6. **Body**: usually JSON.

**Real exchange from this project:**

```
GET /api/v1/bookings/?tutor=1          Authorization: Token 2607bc75…

HTTP/1.1 200 OK
Content-Type: application/json
{"count":1,"next":null,"previous":null,"results":[
  {"id":1,"student":1,"student_name":"Zayd Khan","tutor":1,"tutor_name":"Amina Rahman",
   "subject":"Maths","start_time":"2026-11-17T16:00:00Z","duration_mins":55,
   "end_time":"2026-11-17T16:55:00Z","fee_pence":4000,"status":"confirmed"}]}
```

```
POST /api/v1/bookings/   (same tutor, same time)      -> 409 Conflict
{"error":"Tutor is already booked at that time."}

POST /api/v1/bookings/   {"duration_mins": 5, ...}    -> 400 Bad Request
{"duration_mins":["duration_mins must be between 15 and 180"]}

GET  /api/v1/bookings/   (no token)                   -> 401 Unauthorized
{"detail":"Authentication credentials were not provided."}
```

Note `count / next / previous / results`: that is **pagination**. Never return an unbounded list; one big customer would take the server down.

---

## 3. The learning path: do these in order

### Step 1: Read the bare version, `bookings/views_raw.py` (30 min)
No framework. A view is a function `HttpRequest -> HttpResponse`. It has five numbered steps: **parse → validate → look up → do work → respond**. Every API ever written does these five things. Try it:

```bash
curl -s localhost:8000/raw/tutors/
```

### Step 2: Read the same thing with DRF (`serializers.py` + `views.py`) (45 min)
Notice how much disappeared: parsing, validation, JSON rendering, URL wiring, pagination. DRF **automates the five steps**. It does not change them.

Exercise: `POST` a body containing `"fee_pence": 1`. Read `test_create_booking_sets_price_server_side` to see why it is ignored. *Never trust the client with prices.* This is the first thing a security-minded client will ask about.

### Step 3: Break the double-booking rule on purpose (30 min)
Look at your Node code `api/bookings.js` lines ~190–203: it does *check, then insert*. Two requests arriving in the same millisecond both pass the check and both insert. (That's why you also added `bookings_no_tutor_overlap` in SQL.)

In Django the rule lives in the database: see `ExclusionConstraint` in `models.py`. Run `python manage.py sqlmigrate bookings 0001` and find:

```sql
CONSTRAINT "bookings_no_tutor_overlap"
  EXCLUDE USING GIST ("tutor_id" WITH =, (TSTZRANGE("start_time","end_time")) WITH &&)
  WHERE (NOT ("status" = 'cancelled'))
```

> **Principle to take everywhere:** if a rule must *never* be violated (no double booking, no negative balance, one payment per invoice), enforce it in the database. Application code is for friendly error messages; the database is the guarantee.

### Step 4: Read the SQL the ORM writes (20 min)
```python
python manage.py shell
>>> from bookings.models import Booking
>>> print(Booking.objects.select_related("student","tutor").filter(status="confirmed").query)
```
Remove `select_related` and loop over bookings printing `b.tutor.name`: that's the **N+1 query problem**, the #1 performance bug in Django apps and a very common interview/client question.

### Step 5: Change something yourself
Add `GET /api/v1/tutors/{id}/availability/` returning that tutor's confirmed bookings for a date. You'll touch: `views.py` (an `@action`), maybe a new serializer, and a test. Ask me to review it.

---

## 4. Your current stack vs this one (the translation table)

| Concern | Seeds today (Node + Supabase) | Django equivalent |
|---|---|---|
| Hosting model | Vercel **serverless functions**: each request may spin up a fresh process | A long-running **server process** (gunicorn) behind a load balancer |
| Routing | File name = URL (`api/bookings.js`), plus `?action=confirm` | Explicit table in `urls.py`; method + path picks the handler |
| DB access | Hand-rolled `lib/db.js` calling Supabase's auto-generated REST (PostgREST) | **ORM**: `Booking.objects.filter(...)` → SQL |
| Schema changes | `supabase/migrations/*.sql` written by hand | `makemigrations` generates them from models |
| Auth | Supabase Auth JWT; `lib/auth.js` asks Supabase "who is this?" on **every** request | `Authentication` classes; token/session checked locally against DB |
| Authorisation | `requireAdmin` helper + Postgres **RLS** policies | `permission_classes` per view + object-level checks |
| Validation | `if (!parentEmail) return 400` by hand | Serializers |
| Scheduled jobs | `vercel.json` crons hitting URLs | Celery beat / cron + management commands |
| Tests | `node --test` with mocks | `manage.py test` against real Postgres |
| Back-office UI | Built by hand | `admin.py`: free |

**On "Supabase vs plain Postgres, or both?"**: Supabase *is* Postgres, plus extras (auth, REST API, storage, RLS). Django only needs the Postgres. Sensible path:
1. Learn on **local Postgres** (this project).
2. Later, point `DATABASES` at a Supabase **connection string** to run Django against a *copy/branch* DB, never production while you're learning. Django will create its own `bookings_*` tables; they do not replace your existing `public.bookings`.
3. Pick **one** owner for auth. Running Supabase Auth *and* Django auth is where the confusion starts.

Honest caveat: this demo models the *ideas* (tutors, students, bookings, overlap rule), not your full production schema (payments, payouts, enrolments, RLS). Porting those is a good later exercise, not a prerequisite.

---

## 5. REST vs GraphQL (what you asked at the end)

**REST** (this project): many endpoints, one per resource. The **server decides the response shape**.
`GET /bookings/1/` and `GET /tutors/1/` are two calls.

**GraphQL**: **one endpoint** (`POST /graphql`). The **client sends a query describing exactly the fields it wants**:

```graphql
query {
  booking(id: 1) { startTime  tutor { name }  student { studentName } }
}
```
→ returns exactly that shape in one round trip.

| | REST | GraphQL |
|---|---|---|
| Endpoints | many | one |
| Over-fetching | common | client picks fields |
| Caching | easy (HTTP/URL based) | harder |
| Learning curve / tooling | low, universal | higher |
| Best when | standard CRUD, public/partner APIs, billing systems | many different client screens (mobile + web) needing different shapes |

Both sit on the **same models and database**; GraphQL is a different front door. In Django it's `strawberry-django` or `graphene-django`. For a CRM billing system the likely answer is **REST** (simple, cacheable, auditable, easy to rate-limit). You'd pick GraphQL for a very flexible dashboard UI. I haven't built a GraphQL version here; say the word and we add one next to the REST one so you can compare the two directly.

---

## 6. Where Databricks fits (and why it's separate)

```
Django app  ──writes──▶  PostgreSQL  (OLTP: many small reads/writes, strict correctness)
                              │
                 copy of the data (nightly export / CDC / replication)
                              ▼
                        Databricks  (OLAP: scan millions of rows, aggregate, ML)
```

- **Postgres** answers "create this booking, *now*, correctly, 5,000 times a minute".
- **Databricks** answers "what was revenue per tutor per month for two years?" without slowing the app.
- You **never** point analysts at the live production DB (one bad query slows customers) and the app never reads from Databricks.
- Data moves by **batch export, change-data-capture (e.g. Debezium), or Databricks Lakehouse Federation / JDBC** reading from a *read replica*.

An analytics query you'd write in Databricks SQL against copied tables:

```sql
SELECT t.name,
       date_trunc('month', b.start_time) AS month,
       count(*)                         AS lessons,
       sum(b.fee_pence) / 100.0         AS revenue_gbp
FROM   bookings_booking b
JOIN   bookings_tutor   t ON t.id = b.tutor_id
WHERE  b.status <> 'cancelled'
GROUP  BY 1, 2
ORDER  BY 2, 3 DESC;
```

I can't create a Databricks workspace for you from here, so that part is explained, not demonstrated. The free **Databricks Free Edition** lets you upload a CSV exported from this DB (`\copy bookings_booking to 'b.csv' csv header` in psql) and run exactly that query.

---

## 7. Follow-up questions a client may ask, with answers you can now give

**"How do you stop two people booking the same slot?"**
A database exclusion constraint, not just app code. Application checks can race; a constraint can't. (`models.py`, `test_overlapping_booking_is_409`.)

**"What if a client edits the price in the request?"**
Ignored. Price is computed server-side; the field is `read_only`. (`test_create_booking_sets_price_server_side`.)

**"How is the API secured?"**
TLS in transit; token authentication on every request; deny-by-default (`DEFAULT_PERMISSION_CLASSES = IsAuthenticated`); staff-only endpoints for customer data; serializers expose an allow-list of fields, not whole rows.

**"What does a 401 vs 403 mean?"**
401: we don't know who you are (no/invalid credentials). 403: we know you, you may not do this.

**"How do you change the database safely?"**
Versioned migrations in source control, applied in order, reviewed like code, tested on a copy first.

**"What happens when you have 10× the users?"**
Run more stateless app servers behind a load balancer; add DB indexes; paginate; fix N+1 queries; add a read replica; move slow work (emails, invoices) to a background queue (Celery). The database is usually the bottleneck, not the Python.

**"How does billing avoid charging twice?"**
*Idempotency*: each charge carries a unique key, so a retried request is recognised and not repeated (Stripe supports this natively). Your `webhook.js` and billing cron are the places to study this next.

**"Why integer pence?"**
Floating-point can't represent 0.1 exactly; money errors compound. Store whole pence.

**"How do you know it works?"**
Automated tests against a real Postgres, including the failure paths (conflict, bad input, unauthorised).

---

## 8. Suggested next steps

1. Do Steps 1–5 above and note anything you can't explain; bring it back and we'll go through it.
2. Add `Payment` and `Invoice` models, then a Stripe-style webhook endpoint with idempotency. That is the closest analogue to energy-company billing.
3. Add a GraphQL endpoint beside REST and compare.
4. Export data and run the Databricks query above.
5. Deploy it (e.g. Render/Fly/Railway with managed Postgres) so you've seen a real HTTPS deploy.

Settings here are **dev-only** (`DEBUG=True`, hard-coded `SECRET_KEY`); don't deploy without changing them.
