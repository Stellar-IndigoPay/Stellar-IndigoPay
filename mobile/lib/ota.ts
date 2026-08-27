import * as Updates from 'expo-updates';
import { Alert } from 'react-native';

export async function checkAndApplyUpdates() {
  if (__DEV__) return;
  try {
    const update = await Updates.checkForUpdateAsync();
    if (update.isAvailable) {
      const currentVersion = Updates.runtimeVersion;
      const newVersion = update.manifest?.runtimeVersion;

      // Extract major version
      const getMajor = (version?: string) => {
        if (!version) return null;
        const parts = version.split('.');
        return parts.length > 0 ? parts[0] : null;
      };

      const currentMajor = getMajor(currentVersion);
      const newMajor = getMajor(newVersion as string | undefined);

      if (currentMajor && newMajor && currentMajor !== newMajor) {
        console.log("Incompatible native runtime version (semver major mismatch). Update refused.");
        return;
      }

      await Updates.fetchUpdateAsync();
      await Updates.reloadAsync();
    }
  } catch (error) {
    console.log("Error checking for updates", error);
  }
}
