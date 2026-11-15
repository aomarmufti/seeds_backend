from django.contrib import admin
from django.urls import path
from django.views.decorators.csrf import csrf_exempt
from strawberry.django.views import GraphQLView

from tutors import views
from tutors.schema import schema

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/tutors/", views.tutors),
    path("graphql/", csrf_exempt(GraphQLView.as_view(schema=schema))),
]
