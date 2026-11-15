"""`python manage.py seed_demo` — creates demo tutors/students and an admin login."""
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.utils import timezone

from bookings.models import Booking, Student, Tutor


class Command(BaseCommand):
    help = "Create demo data (safe to re-run)."

    def handle(self, *args, **opts):
        User = get_user_model()
        if not User.objects.filter(username="admin").exists():
            User.objects.create_superuser("admin", "admin@example.com", "admin12345")
        tutors = [Tutor.objects.get_or_create(name=n)[0] for n in ("Amina Rahman", "Daniel Okafor")]
        s1, _ = Student.objects.get_or_create(parent_email="p1@example.com",
                                              defaults={"parent_name": "Sara Khan", "student_name": "Zayd Khan"})
        s2, _ = Student.objects.get_or_create(parent_email="p2@example.com",
                                              defaults={"parent_name": "Tom Reid", "student_name": "Ella Reid"})
        base = (timezone.now() + timedelta(days=2)).replace(hour=16, minute=0, second=0, microsecond=0)
        if not Booking.objects.exists():
            Booking.objects.create(student=s1, tutor=tutors[0], subject="Maths", start_time=base, fee_pence=4000)
            Booking.objects.create(student=s2, tutor=tutors[1], subject="Physics", start_time=base, fee_pence=4000)
        self.stdout.write(self.style.SUCCESS("Seeded. Login: admin / admin12345"))
