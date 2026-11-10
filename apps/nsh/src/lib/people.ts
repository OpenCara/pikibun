import { computed, context, type Accessor } from "nsh";
import { memberPerson, peopleDirectory, segment, username, type Person, type WorkspaceMember } from "../shared";
import { auth, session } from "./auth";
import { createResource } from "./resource";

export interface People {
  person: (id: string) => Person;
  list: Person[];
}

export function createWorkspacePeople(workspaceId: Accessor<string | null>): Accessor<People> {
  const members = createResource<{ members: WorkspaceMember[] }>(() => {
    const id = workspaceId();
    return id ? `/api/workspaces/${segment(id)}/members` : null;
  });
  return computed(() => {
    const { user } = session();
    const list = (members.data()?.members ?? []).map(memberPerson);
    if (!list.some(person => person.id === user.id)) list.push({ id: user.id, username: user.username, githubLogin: user.githubLogin });
    return { person: peopleDirectory(list), list };
  });
}

export const PeopleContext = context<Accessor<People> | null>(null);

export function createUsername(): (id: string, you?: boolean) => string {
  const people = PeopleContext();
  return (id, you) => {
    const state = auth();
    const user = state.status === "signedIn" ? state.user : null;
    if (you && id === user?.id) return "you";
    return people ? username(people().person(id)) : id === user?.id ? username({ id, username: user.username, githubLogin: user.githubLogin }) : username({ id });
  };
}
