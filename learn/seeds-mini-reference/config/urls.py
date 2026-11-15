from django.contrib import admin
from django.urls import path

from tutors import views

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/tutors/", views.tutors),
]
