import { computed, context, type Accessor } from "nsh";
import { memberPerson, peopleDirectory, segment, username, type Person, type WorkspaceMember } from "../shared";
import { auth, session } from "./auth";
import { createResource } from "./resource";

/** The people a screen can name by username: a workspace's members and the signed-in user. */
export interface People {
  person: (id: string) => Person;
}

/** A workspace's members and the signed-in user. Until the members load, only the signed-in user has a username. */
export function createWorkspacePeople(workspaceId: Accessor<string | null>): Accessor<People> {
  const members = createResource<{ members: WorkspaceMember[] }>(() => {
    const id = workspaceId();
    return id ? `/api/workspaces/${segment(id)}/members` : null;
  });
  return computed(() => {
    const { user } = session();
    const list = (members.data()?.members ?? []).map(memberPerson);
    if (!list.some(person => person.id === user.id)) list.push({ id: user.id, username: user.username, githubLogin: user.githubLogin });
    return { person: peopleDirectory(list) };
  });
}

export const PeopleContext = context<Accessor<People> | null>(null);

/**
 * A user's username, as the web's `<Username>` shows it; `you` names the signed-in user "you". Works signed out too
 * (a share link's viewer), where nobody is "you".
 */
export function createUsername(): (id: string, you?: boolean) => string {
  const people = PeopleContext();
  return (id, you) => {
    const state = auth();
    const user = state.status === "signedIn" ? state.user : null;
    if (you && id === user?.id) return "you";
    return people ? username(people().person(id)) : id === user?.id ? username({ id, username: user.username, githubLogin: user.githubLogin }) : username({ id });
  };
}
