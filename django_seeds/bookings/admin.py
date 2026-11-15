from django.contrib import admin

from .models import Booking, Student, Tutor

# One line each gives you a full back-office UI at /admin/ — the kind of thing
# a CRM support team would use to look up a customer. Free with Django.
admin.site.register(Tutor)
admin.site.register(Student)


@admin.register(Booking)
class BookingAdmin(admin.ModelAdmin):
    list_display = ("student", "tutor", "subject", "start_time", "status", "fee_pence")
    list_filter = ("status", "tutor")
