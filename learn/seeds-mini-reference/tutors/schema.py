import strawberry

from .models import Tutor


@strawberry.type
class TutorType:
    """The shape of a tutor in GraphQL. Clients can ask for any of these fields."""

    id: int
    name: str
    subject: str


def to_type(tutor: Tutor) -> TutorType:
    return TutorType(id=tutor.id, name=tutor.name, subject=tutor.subject)


@strawberry.type
class Query:
    """Everything a client can READ."""

    @strawberry.field
    def tutors(self) -> list[TutorType]:
        return [to_type(t) for t in Tutor.objects.order_by("id")]

    @strawberry.field
    def tutor(self, id: int) -> TutorType | None:
        tutor = Tutor.objects.filter(id=id).first()
        return to_type(tutor) if tutor else None


@strawberry.type
class Mutation:
    """Everything a client can CHANGE."""

    @strawberry.mutation
    def add_tutor(self, name: str, subject: str) -> TutorType:
        name, subject = name.strip(), subject.strip()
        if not name or not subject:
            raise ValueError("name and subject are required")
        return to_type(Tutor.objects.create(name=name, subject=subject))


schema = strawberry.Schema(query=Query, mutation=Mutation)
