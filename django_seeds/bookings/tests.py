"""
Run with:  python manage.py test
Django creates a throwaway test database in real Postgres, so the overlap
constraint is genuinely exercised (no mocks).
"""
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase

from .models import Booking, Student, Tutor


class BookingApiTests(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.staff = User.objects.create_user("staff", password="x", is_staff=True)
        self.user = User.objects.create_user("parent", password="x")
        self.tutor = Tutor.objects.create(name="Amina")
        self.student = Student.objects.create(parent_name="P", parent_email="p@x.com", student_name="S")
        self.start = (timezone.now() + timedelta(days=3)).replace(minute=0, second=0, microsecond=0)

    def auth(self, user):
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {Token.objects.get_or_create(user=user)[0].key}")

    def payload(self, start=None, **extra):
        return {"student": self.student.id, "tutor": self.tutor.id, "subject": "Maths",
                "start_time": (start or self.start).isoformat(), **extra}

    def test_requires_authentication(self):
        r = self.client.get("/api/v1/bookings/")
        self.assertEqual(r.status_code, 401)

    def test_create_booking_sets_price_server_side(self):
        self.auth(self.user)
        r = self.client.post("/api/v1/bookings/", self.payload(fee_pence=1), format="json")  # client tries to set £0.01
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.data["fee_pence"], 4000)   # ignored; server price used

    def test_overlapping_booking_is_409(self):
        self.auth(self.user)
        self.assertEqual(self.client.post("/api/v1/bookings/", self.payload(), format="json").status_code, 201)
        r = self.client.post("/api/v1/bookings/", self.payload(self.start + timedelta(minutes=30)), format="json")
        self.assertEqual(r.status_code, 409)

    def test_back_to_back_is_allowed(self):
        self.auth(self.user)
        self.client.post("/api/v1/bookings/", self.payload(), format="json")
        r = self.client.post("/api/v1/bookings/", self.payload(self.start + timedelta(minutes=55)), format="json")
        self.assertEqual(r.status_code, 201)

    def test_validation_error_is_400(self):
        self.auth(self.user)
        r = self.client.post("/api/v1/bookings/", self.payload(duration_mins=5), format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("duration_mins", r.data)

    def test_only_staff_can_cancel_and_slot_is_freed(self):
        self.auth(self.user)
        bid = self.client.post("/api/v1/bookings/", self.payload(), format="json").data["id"]
        self.assertEqual(self.client.post(f"/api/v1/bookings/{bid}/cancel/").status_code, 403)
        self.auth(self.staff)
        self.assertEqual(self.client.post(f"/api/v1/bookings/{bid}/cancel/").status_code, 200)
        self.auth(self.user)  # cancelled booking no longer blocks the slot
        self.assertEqual(self.client.post("/api/v1/bookings/", self.payload(), format="json").status_code, 201)

    def test_students_are_staff_only(self):
        self.auth(self.user)
        self.assertEqual(self.client.get("/api/v1/students/").status_code, 403)
        self.auth(self.staff)
        self.assertEqual(self.client.get("/api/v1/students/").status_code, 200)

    def test_raw_view_conflict_matches(self):
        body = {"student_id": self.student.id, "tutor_id": self.tutor.id,
                "subject": "Maths", "start_time": self.start.isoformat()}
        self.assertEqual(self.client.post("/raw/bookings/", body, format="json").status_code, 201)
        self.assertEqual(self.client.post("/raw/bookings/", body, format="json").status_code, 409)
        self.assertEqual(Booking.objects.count(), 1)
