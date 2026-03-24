import type { Profile, ProfileId } from "../schemas/profile.js";
import { ProfileSchema } from "../schemas/profile.js";
import type { ProfileRegistry } from "./types.js";

export function createProfileRegistry(initial: Profile[] = []): ProfileRegistry {
  const store = new Map<ProfileId, Profile>();

  for (const profile of initial) {
    ProfileSchema.parse(profile);
    store.set(profile.id, profile);
  }

  return {
    get(id) {
      return store.get(id);
    },
    list() {
      return Array.from(store.values());
    },
    register(profile) {
      ProfileSchema.parse(profile);
      store.set(profile.id, profile);
    },
  };
}
