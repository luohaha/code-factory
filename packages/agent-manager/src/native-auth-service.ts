import { NativeProfileStore, nativeAuthDatabasePath, type NativeApiFormat, type NativeApiProfile,
  type NativeApiProfileSecret } from './native-auth.js';
import { StoreNotFoundError } from './store.js';

/** Web-facing profile operations. API responses contain metadata only. */
export class NativeAuthService {
  readonly #profiles: NativeProfileStore;

  constructor(nativeConversationDatabasePath: string) {
    this.#profiles = new NativeProfileStore(nativeAuthDatabasePath(nativeConversationDatabasePath));
  }

  list(): NativeApiProfile[] { return this.#profiles.list(); }
  get(id: string): NativeApiProfileSecret | null { return this.#profiles.get(id); }
  save(input: { id?: string; format: NativeApiFormat; baseUrl: string; apiKey?: string; modelName: string }): NativeApiProfile {
    const previous = input.id ? this.#profiles.get(input.id) : null;
    if (input.id && !previous) throw new StoreNotFoundError(`Native API profile ${input.id} not found`);
    return this.#profiles.save({ ...input, apiKey: input.apiKey?.trim() || previous?.apiKey || '' });
  }
  remove(id: string): void {
    if (!this.#profiles.delete(id)) throw new StoreNotFoundError(`Native API profile ${id} not found`);
  }
  async close(): Promise<void> { this.#profiles.close(); }
}
