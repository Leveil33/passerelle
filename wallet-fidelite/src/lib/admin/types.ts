// Ce dont l'administration a besoin. Deux « accès » séparés, pour que les droits soient clairs :
//  • OwnerStore : AU NOM de l'employé connecté (la base applique ses droits : un employé ou un autre commerce n'obtient rien) ;
//  • ServerAdmin : avec la clé secrète, uniquement pour ce qu'un employé ne peut pas faire lui-même
//    (créer un compte, ranger une image, créer un commerce) et TOUJOURS après avoir vérifié les droits.

export type Role = "owner" | "staff";

export interface OwnerStore {
  userId: string;
  myRole(merchantId: string): Promise<Role | null>;
  merchantOfProgram(programId: string): Promise<string | null>;
  merchantOfLocation(locationId: string): Promise<string | null>;
  merchantOfMember(memberId: string): Promise<string | null>;
  programIds(merchantId: string): Promise<string[]>;
  /** true si une ligne a été modifiée (les règles de sécurité écartent silencieusement les autres). */
  updateProgram(programId: string, patch: Record<string, unknown>): Promise<boolean>;
  updateMerchant(merchantId: string, patch: Record<string, unknown>): Promise<boolean>;
  insertLocation(merchantId: string, loc: { label: string; address: string; latitude: number; longitude: number }): Promise<string>;
  updateLocation(locationId: string, patch: Record<string, unknown>): Promise<boolean>;
  deleteLocation(locationId: string): Promise<boolean>;
  countLocations(merchantId: string): Promise<number>;
  team(merchantId: string): Promise<{ id: string; userId: string; role: Role }[]>;
  /** Lève une StoreError « last_owner » si c'est le dernier propriétaire. */
  removeMember(memberId: string): Promise<boolean>;
}

export interface ServerAdmin {
  /** Crée un compte (déjà confirmé, à changer de mot de passe à la première connexion) ; « exists » si l'adresse est prise. */
  createUser(email: string, temporaryPassword: string): Promise<{ id: string } | "exists">;
  /** Compte existant ou nouveau (réservé à la propriétaire de la solution). */
  ensureUser(email: string, temporaryPassword: string): Promise<{ id: string; created: boolean }>;
  deleteUser(userId: string): Promise<void>;
  emails(userIds: string[]): Promise<Record<string, string>>;
  addMember(merchantId: string, userId: string, role: Role): Promise<void>;
  uploadAsset(path: string, png: Buffer): Promise<string>;
  setLogo(merchantId: string, url: string): Promise<void>;
  setCustomStamp(programId: string, url: string): Promise<void>;
  setPassword(userId: string, password: string): Promise<void>;
  isPlatformAdmin(userId: string): Promise<boolean>;
  createMerchant(adminId: string, name: string, ownerUserId: string, stampsRequired: number, rewardLabel: string): Promise<{ merchantId: string; programId: string }>;
  listMerchants(): Promise<{ id: string; name: string; createdAt: string }[]>;
}

export type PropagateScope = { programIds: string[] };
