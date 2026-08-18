import {
  groupExtensions,
  type CatalogExtensionIdentity,
  type LocalExtensionIdentity
} from './extension-groups';

export function shouldShowExtensionOnboarding(
  providerConnected: boolean,
  localExtensions: LocalExtensionIdentity[],
  catalogExtensions: CatalogExtensionIdentity[]
): boolean {
  if (!providerConnected) return false;
  const groups = groupExtensions(localExtensions, catalogExtensions);
  return groups.yourExtensions.length === 0 && groups.installed.length === 0;
}
