import json

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

from .models import Tutor


@csrf_exempt  # lets our own frontend POST without a CSRF token (fine for learning)
def tutors(request):
    # --- GET /api/tutors/  ->  list every tutor -------------------------
    if request.method == "GET":
        rows = Tutor.objects.order_by("id").values("id", "name", "subject")
        return JsonResponse({"tutors": list(rows)})

    # --- POST /api/tutors/  ->  create one tutor ------------------------
    if request.method == "POST":
        try:
            body = json.loads(request.body)
        except json.JSONDecodeError:
            return JsonResponse({"error": "Body must be valid JSON"}, status=400)
        if not isinstance(body, dict):
            return JsonResponse({"error": "Body must be a JSON object"}, status=400)

        name = str(body.get("name", "")).strip()
        subject = str(body.get("subject", "")).strip()
        if not name or not subject:
            return JsonResponse({"error": "name and subject are required"}, status=400)

        tutor = Tutor.objects.create(name=name, subject=subject)
        return JsonResponse(
            {"id": tutor.id, "name": tutor.name, "subject": tutor.subject}, status=201
        )

    # --- anything else (PUT, DELETE...) ---------------------------------
    return JsonResponse({"error": "Method not allowed"}, status=405)
