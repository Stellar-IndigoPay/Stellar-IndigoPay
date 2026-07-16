/**
 * components/DonationQueueStatus.tsx
 *
 * Queue status UI component.
 *
 * Displays a floating badge showing the number of pending donations,
 * and a bottom-sheet-style modal that lists queued donations with
 * per-item status indicators, retry/dismiss actions, and a "Retry All"
 * button.
 */
import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  FlatList,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useTheme } from "../app/theme";
import {
  getQueuedDonations,
  getPendingCount,
  removeDonation,
  QueuedDonation,
  DonationStatus,
} from "../utils/donationQueue";
import { retryAllNow, processQueue } from "../utils/donationQueueWorker";

// Polling interval for refreshing queue state.
const POLL_INTERVAL_MS = 5_000;

function statusLabel(status: DonationStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "retrying":
      return "Retrying…";
    case "submitted":
      return "Submitted ✓";
    case "failed":
      return "Failed";
  }
}

function statusColor(status: DonationStatus): string {
  switch (status) {
    case "pending":
      return "#f59e0b"; // amber
    case "retrying":
      return "#3b82f6"; // blue
    case "submitted":
      return "#22c55e"; // green
    case "failed":
      return "#ef4444"; // red
  }
}

// ─── Floating Badge ────────────────────────────────────────────────────────

interface FloatingBadgeProps {
  count: number;
  onPress: () => void;
}

function FloatingBadge({ count, onPress }: FloatingBadgeProps) {
  const { colors } = useTheme();

  if (count === 0) return null;

  return (
    <TouchableOpacity
      style={[styles.floatingBadge, { backgroundColor: colors.surface + "F2" }]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityLabel={`${count} pending donation${count > 1 ? "s" : ""}. Tap to view.`}
      accessibilityRole="button"
    >
      <View style={[styles.badgeCircle, { backgroundColor: colors.primary }]}>
        <Text style={styles.badgeCount}>{count > 99 ? "99+" : count}</Text>
      </View>
      <Text style={[styles.badgeLabel, { color: colors.primaryText }]}>
        Pending
      </Text>
    </TouchableOpacity>
  );
}

// ─── Detail Sheet Item ─────────────────────────────────────────────────────

interface QueueItemProps {
  donation: QueuedDonation;
  onDismiss: (id: string) => void;
  colors: ReturnType<typeof useTheme>["colors"];
}

function QueueItem({ donation, onDismiss, colors }: QueueItemProps) {
  const isPending =
    donation.status === "pending" || donation.status === "retrying";
  const isFailed = donation.status === "failed";

  return (
    <View
      style={[
        styles.queueItem,
        {
          backgroundColor: colors.surface,
          borderColor: colors.cardBorder,
        },
      ]}
    >
      <View style={styles.queueItemHeader}>
        <View style={styles.queueItemLeft}>
          <Text style={[styles.queueItemProject, { color: colors.primaryText }]} numberOfLines={1}>
            {donation.projectName}
          </Text>
          <Text style={[styles.queueItemAmount, { color: colors.primary }]}>
            {donation.amount} {donation.currency}
          </Text>
        </View>
        <View
          style={[
            styles.statusPill,
            { backgroundColor: statusColor(donation.status) + "20" },
          ]}
        >
          {donation.status === "retrying" ? (
            <ActivityIndicator size="small" color={statusColor(donation.status)} />
          ) : null}
          <Text
            style={[
              styles.statusPillText,
              { color: statusColor(donation.status) },
            ]}
          >
            {statusLabel(donation.status)}
          </Text>
        </View>
      </View>

      {donation.lastError ? (
        <Text
          style={[styles.errorText, { color: colors.secondaryText }]}
          numberOfLines={2}
        >
          {donation.lastError}
        </Text>
      ) : null}

      {donation.transactionHash ? (
        <Text
          style={[styles.txHashText, { color: colors.secondaryText }]}
          numberOfLines={1}
        >
          Tx: {donation.transactionHash.slice(0, 16)}…
        </Text>
      ) : null}

      {isFailed ? (
        <TouchableOpacity
          style={[styles.dismissButton, { borderColor: colors.border }]}
          onPress={() => onDismiss(donation.id)}
          accessibilityLabel="Dismiss this failed donation"
          accessibilityRole="button"
        >
          <Text style={[styles.dismissButtonText, { color: colors.secondaryText }]}>
            Dismiss
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

// ─── Detail Sheet ──────────────────────────────────────────────────────────

interface DetailSheetProps {
  visible: boolean;
  onClose: () => void;
}

function DetailSheet({ visible, onClose }: DetailSheetProps) {
  const { colors } = useTheme();
  const [donations, setDonations] = useState<QueuedDonation[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    const list = await getQueuedDonations();
    setDonations(list);
  }, []);

  useEffect(() => {
    if (!visible) return;
    refresh();

    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [visible, refresh]);

  const handleRetryAll = async () => {
    setSubmitting(true);
    await retryAllNow();
    await refresh();
    setSubmitting(false);
  };

  const handleDismiss = async (id: string) => {
    await removeDonation(id);
    await refresh();
  };

  const handleClearFailed = async () => {
    const list = await getQueuedDonations();
    const failed = list.filter((d) => d.status === "failed");
    for (const d of failed) {
      await removeDonation(d.id);
    }
    await refresh();
  };

  const pendingCount = donations.filter(
    (d) => d.status === "pending" || d.status === "retrying",
  ).length;
  const failedCount = donations.filter((d) => d.status === "failed").length;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View
          style={[
            styles.sheet,
            { backgroundColor: colors.background },
          ]}
        >
          {/* Handle */}
          <View style={styles.sheetHandle} />

          {/* Header */}
          <View style={styles.sheetHeader}>
            <Text style={[styles.sheetTitle, { color: colors.primaryText }]}>
              Donation Queue
            </Text>
            <TouchableOpacity onPress={onClose} accessibilityLabel="Close queue" accessibilityRole="button">
              <Text style={[styles.closeButton, { color: colors.secondaryText }]}>✕</Text>
            </TouchableOpacity>
          </View>

          <Text style={[styles.sheetSubtitle, { color: colors.secondaryText }]}>
            {pendingCount} pending · {failedCount} failed
          </Text>

          {/* Action buttons */}
          <View style={styles.actionRow}>
            {pendingCount > 0 ? (
              <TouchableOpacity
                style={[styles.actionButton, { backgroundColor: colors.primary }]}
                onPress={handleRetryAll}
                disabled={submitting}
                accessibilityLabel="Retry all pending donations"
                accessibilityRole="button"
              >
                {submitting ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.actionButtonText}>Retry All Now</Text>
                )}
              </TouchableOpacity>
            ) : null}
            {failedCount > 0 ? (
              <TouchableOpacity
                style={[
                  styles.actionButton,
                  styles.secondaryButton,
                  { borderColor: colors.border },
                ]}
                onPress={handleClearFailed}
                accessibilityLabel="Clear all failed donations"
                accessibilityRole="button"
              >
                <Text style={[styles.actionButtonText, { color: colors.primaryText }]}>
                  Clear Failed
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {/* List */}
          <FlatList
            data={donations}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <QueueItem
                donation={item}
                onDismiss={handleDismiss}
                colors={colors}
              />
            )}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Text style={[styles.emptyText, { color: colors.muted }]}>
                  No queued donations.
                </Text>
              </View>
            }
            showsVerticalScrollIndicator={false}
          />
        </View>
      </View>
    </Modal>
  );
}

// ─── Composite Component ──────────────────────────────────────────────────

/**
 * DonationQueueStatus — composite component that renders the floating badge
 * and manages the detail sheet.
 *
 * Usage:
 *   <DonationQueueStatus />
 *   // Renders the floating badge on home screen; tapping opens the sheet.
 */
export default function DonationQueueStatus() {
  const [pendingCount, setPendingCount] = useState(0);
  const [sheetVisible, setSheetVisible] = useState(false);

  useEffect(() => {
    const interval = setInterval(async () => {
      const count = await getPendingCount();
      setPendingCount(count);
    }, POLL_INTERVAL_MS);

    // Initial load
    getPendingCount().then(setPendingCount);

    return () => clearInterval(interval);
  }, []);

  return (
    <>
      <FloatingBadge count={pendingCount} onPress={() => setSheetVisible(true)} />
      <DetailSheet visible={sheetVisible} onClose={() => setSheetVisible(false)} />
    </>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Floating badge
  floatingBadge: {
    flexDirection: "row",
    alignItems: "center",
    position: "absolute",
    bottom: 24,
    right: 16,
    zIndex: 100,
    borderRadius: 24,
    paddingVertical: 8,
    paddingHorizontal: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 6,
    gap: 8,
  },
  badgeCircle: {
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    paddingHorizontal: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeCount: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "800",
  },
  badgeLabel: {
    fontSize: 13,
    fontWeight: "600",
  },
  // Modal overlay
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "85%",
    paddingBottom: 34, // safe area
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#ccc",
    alignSelf: "center",
    marginTop: 12,
    marginBottom: 8,
  },
  sheetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  sheetTitle: {
    fontSize: 20,
    fontWeight: "bold",
  },
  closeButton: {
    fontSize: 22,
    padding: 4,
  },
  sheetSubtitle: {
    fontSize: 13,
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  actionRow: {
    flexDirection: "row",
    paddingHorizontal: 20,
    gap: 10,
    marginBottom: 12,
  },
  actionButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 80,
  },
  secondaryButton: {
    backgroundColor: "transparent",
    borderWidth: 1,
  },
  actionButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  // List
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  queueItem: {
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
  },
  queueItemHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  queueItemLeft: {
    flex: 1,
    marginRight: 8,
  },
  queueItemProject: {
    fontSize: 15,
    fontWeight: "600",
  },
  queueItemAmount: {
    fontSize: 13,
    fontWeight: "700",
    marginTop: 2,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 12,
    gap: 4,
  },
  statusPillText: {
    fontSize: 11,
    fontWeight: "700",
  },
  errorText: {
    fontSize: 12,
    marginTop: 6,
    lineHeight: 16,
  },
  txHashText: {
    fontSize: 11,
    marginTop: 4,
  },
  dismissButton: {
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  dismissButtonText: {
    fontSize: 12,
    fontWeight: "600",
  },
  emptyContainer: {
    alignItems: "center",
    paddingTop: 32,
  },
  emptyText: {
    fontSize: 14,
  },
});
