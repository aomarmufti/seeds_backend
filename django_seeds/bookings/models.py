"""
MODELS = the database schema, written as Python classes.

Compare with your existing Supabase SQL in
  supabase/migrations/20260701000000_baseline_schema_snapshot.sql

    SQL:     create table students ( parent_email text not null unique, ... )
    Django:  class Student(models.Model): parent_email = models.EmailField(unique=True)

You never write CREATE TABLE by hand. You edit this file, run
`python manage.py makemigrations` (Django diffs this file against the last
migration and writes a new migration file), then `python manage.py migrate`
(Django runs that SQL against Postgres). Same idea as your supabase/migrations
folder, except Django generates the SQL for you.
"""
from datetime import timedelta

from django.contrib.postgres.constraints import ExclusionConstraint
from django.contrib.postgres.fields import DateTimeRangeField, RangeOperators
from django.db import models
from django.db.models import F, Func, Q


class TsTzRange(Func):
    """Build a Postgres tstzrange(start, end) value inside a constraint."""
    function = "TSTZRANGE"
    output_field = DateTimeRangeField()


class Tutor(models.Model):
    name = models.CharField(max_length=120, unique=True)
    email = models.EmailField(blank=True)
    meeting_link = models.URLField(blank=True)

    def __str__(self):
        return self.name


class Student(models.Model):
    parent_name = models.CharField(max_length=120)
    parent_email = models.EmailField(unique=True)   # -> UNIQUE constraint in Postgres
    student_name = models.CharField(max_length=120)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.student_name} ({self.parent_email})"


class Booking(models.Model):
    class Status(models.TextChoices):
        CONFIRMED = "confirmed", "Confirmed"
        CANCELLED = "cancelled", "Cancelled"
        COMPLETED = "completed", "Completed"

    # ForeignKey = "references students(id)". on_delete says what happens to
    # bookings if the student row is deleted (PROTECT = refuse, don't lose billing history).
    student = models.ForeignKey(Student, on_delete=models.PROTECT, related_name="bookings")
    tutor = models.ForeignKey(Tutor, on_delete=models.PROTECT, related_name="bookings")
    subject = models.CharField(max_length=80)
    start_time = models.DateTimeField()
    duration_mins = models.PositiveIntegerField(default=55)
    # Derived from start_time + duration_mins in save(). Stored as a real column
    # so Postgres can use it in the overlap constraint below (your Supabase
    # schema does the same thing with a trigger).
    end_time = models.DateTimeField(editable=False)
    # Money is ALWAYS integer pence. Never floats. (Your Node code does the same.)
    fee_pence = models.PositiveIntegerField(default=0)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.CONFIRMED)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["start_time"]
        constraints = [
            # The database itself refuses two live bookings for one tutor whose
            # time ranges overlap. This is the same guarantee as your
            # `bookings_no_tutor_overlap` constraint. App-level "check then
            # insert" has a race (two requests pass the check at the same
            # instant); a constraint cannot be raced.
            ExclusionConstraint(
                name="bookings_no_tutor_overlap",
                expressions=[
                    ("tutor", RangeOperators.EQUAL),
                    (TsTzRange("start_time", "end_time"), RangeOperators.OVERLAPS),
                ],
                condition=~Q(status="cancelled"),
            ),
            models.CheckConstraint(condition=Q(end_time__gt=F("start_time")), name="booking_end_after_start"),
        ]

    def save(self, *args, **kwargs):
        self.end_time = self.start_time + timedelta(minutes=self.duration_mins)
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.student.student_name} with {self.tutor.name} @ {self.start_time:%Y-%m-%d %H:%M}"
