"""
STAGE 2 — the same endpoints, the way real Django teams write them (DRF).

A ViewSet is a class that bundles the standard operations for one resource.
Register it with a Router and you get ALL of this URL table for free:

    GET    /api/v1/bookings/          -> list()      (paginated)
    POST   /api/v1/bookings/          -> create()
    GET    /api/v1/bookings/{id}/     -> retrieve()
    PATCH  /api/v1/bookings/{id}/     -> partial_update()
    DELETE /api/v1/bookings/{id}/     -> destroy()   (disabled below)
    POST   /api/v1/bookings/{id}/cancel/  -> our custom @action

That pattern — plural noun in the URL, HTTP verb says what to do — is REST.
"""
from django.db import IntegrityError, transaction
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAdminUser
from rest_framework.response import Response

from .models import Booking, Student, Tutor
from .serializers import BookingSerializer, StudentSerializer, TutorSerializer


class TutorViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Tutor.objects.all().order_by("name")
    serializer_class = TutorSerializer


class StudentViewSet(viewsets.ModelViewSet):
    queryset = Student.objects.all().order_by("-created_at")
    serializer_class = StudentSerializer
    permission_classes = [IsAdminUser]   # only staff may touch family data


class BookingViewSet(mixins.CreateModelMixin, mixins.RetrieveModelMixin,
                     mixins.ListModelMixin, viewsets.GenericViewSet):
    # select_related = one SQL JOIN instead of 1 extra query PER ROW (the "N+1" problem).
    queryset = Booking.objects.select_related("student", "tutor")
    serializer_class = BookingSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        # Query-string filters: GET /bookings/?tutor=1&status=confirmed
        for field in ("tutor", "student", "status"):
            value = self.request.query_params.get(field)
            if value:
                qs = qs.filter(**{field: value})
        return qs

    def create(self, request, *args, **kwargs):
        try:
            with transaction.atomic():   # savepoint: see views_raw.py for why
                return super().create(request, *args, **kwargs)
        except IntegrityError:
            # Postgres' exclusion constraint rejected an overlapping slot.
            return Response({"error": "Tutor is already booked at that time."},
                            status=status.HTTP_409_CONFLICT)

    @action(detail=True, methods=["post"], permission_classes=[IsAdminUser])
    def cancel(self, request, pk=None):
        """POST /api/v1/bookings/{id}/cancel/ — an *action*, not a CRUD verb."""
        booking = self.get_object()
        if booking.status == Booking.Status.CANCELLED:
            return Response({"error": "already cancelled"}, status=status.HTTP_409_CONFLICT)
        booking.status = Booking.Status.CANCELLED
        booking.save(update_fields=["status"])
        return Response(self.get_serializer(booking).data)
