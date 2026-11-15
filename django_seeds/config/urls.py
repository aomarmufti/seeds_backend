"""
URL ROUTING = the "which function handles this address?" table.

When a request for  POST /api/v1/bookings/  arrives, Django walks this list
top to bottom, finds the first matching pattern, and calls that view.
(Your Node app does this with *file names*: api/bookings.js => /api/bookings.
Django uses an explicit table instead.)
"""
from django.contrib import admin
from django.urls import include, path
from rest_framework.authtoken.views import obtain_auth_token
from rest_framework.routers import DefaultRouter

from bookings import views, views_raw

router = DefaultRouter()
router.register("tutors", views.TutorViewSet)
router.register("students", views.StudentViewSet)
router.register("bookings", views.BookingViewSet)

urlpatterns = [
    path("admin/", admin.site.urls),
    # Stage 1: hand-written, no framework
    path("raw/tutors/", views_raw.tutors_list),
    path("raw/bookings/", views_raw.bookings_create),
    # Stage 2: DRF. "v1" in the path lets you ship a breaking v2 later without breaking old clients.
    path("api/v1/", include(router.urls)),
    # POST {"username","password"} -> {"token": "..."}   (login)
    path("api/v1/auth/token/", obtain_auth_token),
]
