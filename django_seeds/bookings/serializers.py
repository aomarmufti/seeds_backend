"""
SERIALIZERS = the contract between JSON and your models.

One class does three jobs that views_raw.py did by hand:
  1. Parse + validate incoming JSON            (steps 1-2 in views_raw)
  2. Look up foreign keys (student, tutor)     (step 3)
  3. Turn model instances back into JSON       (step 5)

`read_only_fields` is a SECURITY feature: a client can send fee_pence in the
body and it is silently ignored — the server decides the price.
"""
from rest_framework import serializers

from .models import Booking, Student, Tutor
from .services import price_for


class TutorSerializer(serializers.ModelSerializer):
    class Meta:
        model = Tutor
        fields = ["id", "name"]          # NOT email/meeting_link: don't leak what clients don't need


class StudentSerializer(serializers.ModelSerializer):
    class Meta:
        model = Student
        fields = ["id", "parent_name", "parent_email", "student_name", "created_at"]
        read_only_fields = ["created_at"]


class BookingSerializer(serializers.ModelSerializer):
    # Nested read-only view: GET shows the tutor's name, POST sends just `tutor` (an id).
    tutor_name = serializers.CharField(source="tutor.name", read_only=True)
    student_name = serializers.CharField(source="student.student_name", read_only=True)

    class Meta:
        model = Booking
        fields = ["id", "student", "student_name", "tutor", "tutor_name", "subject",
                  "start_time", "duration_mins", "end_time", "fee_pence", "status"]
        read_only_fields = ["end_time", "fee_pence", "status"]

    def validate_duration_mins(self, value):
        # validate_<fieldname> runs automatically; raise -> HTTP 400 with this message.
        if not 15 <= value <= 180:
            raise serializers.ValidationError("duration_mins must be between 15 and 180")
        return value

    def create(self, validated_data):
        validated_data["fee_pence"] = price_for(validated_data["subject"])
        return super().create(validated_data)
