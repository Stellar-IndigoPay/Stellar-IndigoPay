import {
  View,
  Text,
  StyleSheet,
  Switch,
  TextInput,
  ScrollView,
  TouchableOpacity,
} from "react-native";
import { useBiometricAuth } from "../hooks/useBiometricAuth";
import { useTheme } from "./theme";
import { useRouter } from "expo-router";

export default function SettingsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const {
    isAvailable,
    biometricType,
    threshold,
    isEnabled,
    setBiometricThreshold,
    setIsEnabled,
  } = useBiometricAuth();

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>
          Security Settings
        </Text>
        
        <View style={[styles.row, { borderColor: colors.border }]}>
          <View style={styles.textContainer}>
            <Text style={[styles.label, { color: colors.primaryText }]}>
              Biometric Confirmation
            </Text>
            <Text style={[styles.description, { color: colors.secondaryText }]}>
              Require biometric validation for donations.
            </Text>
          </View>
          <Switch
            value={isEnabled}
            onValueChange={setIsEnabled}
            disabled={!isAvailable}
            trackColor={{ false: colors.border, true: colors.primary }}
          />
        </View>

        {isEnabled && isAvailable && (
          <View style={[styles.row, styles.column, { borderColor: colors.border }]}>
            <Text style={[styles.label, { color: colors.primaryText }]}>
              Confirmation Threshold (XLM)
            </Text>
            <Text style={[styles.description, { color: colors.secondaryText, marginBottom: 8 }]}>
              Require {biometricType || "biometric"} validation for donations greater than or equal to this amount.
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.inputBackground,
                  borderColor: colors.inputBorder,
                  color: colors.primaryText,
                },
              ]}
              value={String(threshold)}
              onChangeText={(text) => {
                const val = parseFloat(text);
                if (!isNaN(val) && val >= 0) {
                  setBiometricThreshold(val);
                } else if (text === "") {
                  setBiometricThreshold(0);
                }
              }}
              keyboardType="decimal-pad"
              accessibilityLabel="Biometric threshold in XLM"
            />
          </View>
        )}

        <View style={[styles.statusBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.statusLabel, { color: colors.secondaryText }]}>
            Hardware Status:
          </Text>
          <Text style={[styles.statusValue, { color: isAvailable ? colors.primary : colors.muted }]}>
            {isAvailable
              ? `Available (${biometricType})`
              : "Unavailable / No biometrics enrolled"}
          </Text>
        </View>
      </View>

      {/* Notification Settings */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>
          Notifications
        </Text>
        <TouchableOpacity
          style={[styles.linkRow, { borderColor: colors.border }]}
          onPress={() => router.push("/settings/notifications" as `${string}`)}
          accessibilityLabel="Open notification settings"
        >
          <Text style={[styles.label, { color: colors.primaryText }]}>
            Notification Preferences
          </Text>
          <Text style={[styles.linkArrow, { color: colors.secondaryText }]}>
            ›
          </Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  section: {
    padding: 20,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 20,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  column: {
    flexDirection: "column",
    alignItems: "flex-start",
  },
  textContainer: {
    flex: 1,
    paddingRight: 16,
  },
  label: {
    fontSize: 16,
    fontWeight: "600",
  },
  description: {
    fontSize: 13,
    marginTop: 4,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    width: "100%",
    marginTop: 8,
  },
  statusBox: {
    marginTop: 24,
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
  },
  statusLabel: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  statusValue: {
    fontSize: 16,
    fontWeight: "600",
    marginTop: 4,
  },
  linkRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  linkArrow: {
    fontSize: 24,
    fontWeight: "300",
  },
});
