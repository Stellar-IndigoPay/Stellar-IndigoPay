/**
 * app/settings/notifications.tsx
 *
 * Push notification preference management.
 * - Toggle individual notification categories on/off.
 * - Configure Do Not Disturb hours.
 * - Links back to the main settings screen.
 */
import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Switch,
  ScrollView,
  TextInput,
  Alert,
} from "react-native";
import { useTheme } from "../theme";
import { Stack } from "expo-router";
import { useAuth } from "../../providers/AuthProvider";

const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://localhost:4000";

/** Notification categories mirror the pushService data.type values. */
const CATEGORIES: { key: string; label: string; description: string }[] = [
  {
    key: "donation_receipt",
    label: "Donation Confirmations",
    description: "Receipt when your donation is confirmed on-chain.",
  },
  {
    key: "project_update",
    label: "Project Updates",
    description: "News and updates from projects you follow.",
  },
  {
    key: "milestone_reached",
    label: "Milestone Alerts",
    description: "Funding milestones at 25%, 50%, 75%, and 100%.",
  },
  {
    key: "governance_proposal",
    label: "Governance Proposals",
    description: "New community governance proposals open for voting.",
  },
  {
    key: "recurring_reminder",
    label: "Recurring Reminders",
    description: "Reminder 24h before your recurring donation is processed.",
  },
];

interface DndConfig {
  start: string; // "HH:mm" in the configured timezone
  end: string;
  timezone: string;
}

interface Preferences {
  [key: string]: boolean;
}

export default function NotificationSettingsScreen() {
  const { colors } = useTheme();
  const { session } = useAuth();

  const [preferences, setPreferences] = useState<Preferences>({});
  const [dnd, setDnd] = useState<DndConfig | null>(null);
  const [dndEnabled, setDndEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const walletAddress = session?.publicKey || null;

  // ── Load current preferences ──────────────────────────────────────────
  const loadPreferences = useCallback(async () => {
    if (!walletAddress) {
      setLoading(false);
      return;
    }

    try {
      const prefsResp = await fetch(
        `${API_URL}/api/notifications/preferences?walletAddress=${encodeURIComponent(walletAddress)}`,
      );
      const prefsData = await prefsResp.json();

      if (prefsData.success) {
        const { preferences: remotePrefs, dnd: remoteDnd } = prefsData.data;
        setPreferences(remotePrefs || {});

        if (remoteDnd?.start && remoteDnd?.end) {
          setDnd(remoteDnd);
          setDndEnabled(true);
        }
      }
    } catch (err) {
      console.error("Failed to load notification preferences:", err);
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    loadPreferences();
  }, [loadPreferences]);

  // ── Save preferences ──────────────────────────────────────────────────
  const savePreferences = async (
    updatedPrefs: Preferences,
    updatedDnd?: DndConfig | null,
  ) => {
    if (!walletAddress) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        walletAddress,
        preferences: updatedPrefs,
      };
      if (updatedDnd !== undefined) {
        body.dnd = updatedDnd;
      }

      await fetch(`${API_URL}/api/notifications/preferences`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.error("Failed to save notification preferences:", err);
      Alert.alert("Error", "Failed to save preferences. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const toggleCategory = (key: string) => {
    const updated = { ...preferences, [key]: !preferences[key] };
    setPreferences(updated);
    savePreferences(updated, dndEnabled ? dnd : null);
  };

  const toggleDnd = (value: boolean) => {
    setDndEnabled(value);
    if (!value) {
      setDnd(null);
      savePreferences(preferences, null);
    } else if (!dnd) {
      // Default DND: 10 PM – 8 AM local time
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const defaultDnd: DndConfig = {
        start: "22:00",
        end: "08:00",
        timezone: tz,
      };
      setDnd(defaultDnd);
      savePreferences(preferences, defaultDnd);
    }
  };

  const updateDndStart = (value: string) => {
    if (!dnd) return;
    const updated = { ...dnd, start: value };
    setDnd(updated);
    savePreferences(preferences, updated);
  };

  const updateDndEnd = (value: string) => {
    if (!dnd) return;
    const updated = { ...dnd, end: value };
    setDnd(updated);
    savePreferences(preferences, updated);
  };

  // ── Render ────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View
        style={[
          styles.container,
          styles.centered,
          { backgroundColor: colors.background },
        ]}
      >
        <Text style={{ color: colors.secondaryText }}>
          Loading preferences...
        </Text>
      </View>
    );
  }

  if (!walletAddress) {
    return (
      <View
        style={[
          styles.container,
          styles.centered,
          { backgroundColor: colors.background },
        ]}
      >
        <Stack.Screen options={{ title: "Notification Settings" }} />
        <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
          Connect your wallet to manage notification preferences.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
    >
      <Stack.Screen options={{ title: "Notification Settings" }} />

      {/* Category toggles */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>
          Notification Categories
        </Text>
        <Text
          style={[styles.sectionDescription, { color: colors.secondaryText }]}
        >
          Choose which push notifications you want to receive.
        </Text>

        {CATEGORIES.map((cat) => (
          <View
            key={cat.key}
            style={[styles.row, { borderColor: colors.border }]}
          >
            <View style={styles.textContainer}>
              <Text style={[styles.label, { color: colors.primaryText }]}>
                {cat.label}
              </Text>
              <Text
                style={[styles.description, { color: colors.secondaryText }]}
              >
                {cat.description}
              </Text>
            </View>
            <Switch
              value={preferences[cat.key] !== false}
              onValueChange={() => toggleCategory(cat.key)}
              trackColor={{ false: colors.border, true: colors.primary }}
              disabled={saving}
            />
          </View>
        ))}
      </View>

      {/* DND hours */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>
          Do Not Disturb
        </Text>
        <Text
          style={[styles.sectionDescription, { color: colors.secondaryText }]}
        >
          Suppress push notifications during specified hours.
        </Text>

        <View style={[styles.row, { borderColor: colors.border }]}>
          <View style={styles.textContainer}>
            <Text style={[styles.label, { color: colors.primaryText }]}>
              Enable DND
            </Text>
            <Text
              style={[styles.description, { color: colors.secondaryText }]}
            >
              Notifications will be silenced during the configured window.
            </Text>
          </View>
          <Switch
            value={dndEnabled}
            onValueChange={toggleDnd}
            trackColor={{ false: colors.border, true: colors.primary }}
            disabled={saving}
          />
        </View>

        {dndEnabled && dnd && (
          <>
            {/* Start time */}
            <View style={[styles.timeRow, { borderColor: colors.border }]}>
              <Text style={[styles.label, { color: colors.primaryText }]}>
                Quiet from
              </Text>
              <TextInput
                style={[
                  styles.timeInput,
                  {
                    backgroundColor: colors.inputBackground,
                    borderColor: colors.inputBorder,
                    color: colors.primaryText,
                  },
                ]}
                value={dnd.start}
                onChangeText={updateDndStart}
                placeholder="HH:mm"
                placeholderTextColor={colors.muted}
                keyboardType="numbers-and-punctuation"
                maxLength={5}
              />
            </View>

            {/* End time */}
            <View style={[styles.timeRow, { borderColor: colors.border }]}>
              <Text style={[styles.label, { color: colors.primaryText }]}>
                Quiet until
              </Text>
              <TextInput
                style={[
                  styles.timeInput,
                  {
                    backgroundColor: colors.inputBackground,
                    borderColor: colors.inputBorder,
                    color: colors.primaryText,
                  },
                ]}
                value={dnd.end}
                onChangeText={updateDndEnd}
                placeholder="HH:mm"
                placeholderTextColor={colors.muted}
                keyboardType="numbers-and-punctuation"
                maxLength={5}
              />
            </View>

            <View
              style={[
                styles.statusBox,
                {
                  backgroundColor: colors.surface,
                  borderColor: colors.border,
                },
              ]}
            >
              <Text
                style={[styles.statusLabel, { color: colors.secondaryText }]}
              >
                Timezone
              </Text>
              <Text style={[styles.statusValue, { color: colors.muted }]}>
                {dnd.timezone}
              </Text>
            </View>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  emptyText: {
    fontSize: 16,
    textAlign: "center",
  },
  section: {
    padding: 20,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 4,
  },
  sectionDescription: {
    fontSize: 13,
    marginBottom: 16,
    lineHeight: 18,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 16,
    borderBottomWidth: 1,
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
    lineHeight: 18,
  },
  timeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  timeInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
    minWidth: 80,
    textAlign: "center",
  },
  statusBox: {
    marginTop: 16,
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
});
