"""
STAGE 1 — an endpoint with NO framework help.

This is what every web framework is doing for you underneath. Read this file
first so the DRF version in views.py isn't magic.

A "view" is just a function:   HttpRequest in  ->  HttpResponse out.
Django has already done the HTTP/TLS/parsing work by the time this runs:
  - `request.method`  : "GET", "POST", ...
  - `request.body`    : the raw bytes the client sent
  - `request.GET`     : the ?query=string parameters
  - `request.headers` : e.g. Authorization
You return a response with a status code and a body. That is the whole job.

Compare with your Node handler in api/bookings.js: `module.exports = async (req, res)`
-> same shape, different language. The `if (!parentEmail ...) return res.status(400)`
lines there are the manual validation we repeat here.
"""
import json

from django.db import IntegrityError, transaction
from django.http import JsonResponse
from django.utils.dateparse import parse_datetime
from django.views.decorators.csrf import csrf_exempt

from .models import Booking, Student, Tutor
from .services import price_for


def tutors_list(request):
    """GET /raw/tutors/  ->  200 [{"id":1,"name":"..."}, ...]"""
    if request.method != "GET":
        return JsonResponse({"error": "method not allowed"}, status=405)
    data = list(Tutor.objects.values("id", "name"))  # ORM: SELECT id, name FROM bookings_tutor
    return JsonResponse(data, safe=False)


@csrf_exempt  # CSRF protects browser-cookie sessions; this raw demo has no cookies.
def bookings_create(request):
    """POST /raw/bookings/   body: {"student_id":1,"tutor_id":1,"subject":"Maths","start_time":"2026-12-01T16:00:00Z"}"""
    if request.method != "POST":
        return JsonResponse({"error": "method not allowed"}, status=405)

    # 1. PARSE: bytes -> dict. Bad JSON is the client's fault -> 400.
    try:
        body = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "invalid JSON"}, status=400)

    # 2. VALIDATE: never trust the client. (A serializer automates this.)
    missing = [f for f in ("student_id", "tutor_id", "subject", "start_time") if not body.get(f)]
    if missing:
        return JsonResponse({"error": f"missing fields: {missing}"}, status=400)
    start = parse_datetime(body["start_time"])
    if start is None or start.tzinfo is None:
        return JsonResponse({"error": "start_time must be ISO-8601 with timezone"}, status=400)

    # 3. LOOK UP related rows -> 404 if they don't exist.
    try:
        student = Student.objects.get(pk=body["student_id"])
        tutor = Tutor.objects.get(pk=body["tutor_id"])
    except (Student.DoesNotExist, Tutor.DoesNotExist):
        return JsonResponse({"error": "student or tutor not found"}, status=404)

    # 4. DO THE WORK. Price is decided HERE, never taken from the client.
    try:
        # atomic() = a savepoint. If Postgres rejects the INSERT, only this block
        # is rolled back and the connection stays usable. Without it, a failed
        # statement poisons the whole surrounding transaction.
        with transaction.atomic():
            booking = Booking.objects.create(
                student=student, tutor=tutor, subject=body["subject"],
                start_time=start, fee_pence=price_for(body["subject"]),
            )
    except IntegrityError:
        # The DB's exclusion constraint fired: tutor already booked. 409 = Conflict.
        return JsonResponse({"error": "tutor already booked at that time"}, status=409)

    # 5. RESPOND: 201 Created + the new resource.
    return JsonResponse({"id": booking.id, "end_time": booking.end_time.isoformat(),
                         "fee_pence": booking.fee_pence}, status=201)
