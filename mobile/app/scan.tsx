/**
 * app/scan.tsx
 * Scan to Donate — reads a project QR code, validates it against the
 * project registry, and hands off to the donate screen with the project,
 * amount, and memo pre-filled.
 *
 * Recognised QR payloads (see utils/qrParser.ts):
 *   - stellar-indigopay://donate?projectId=X&amount=Y&memo=Z
 *   - indigopay://donate?wallet=G...&project=X          (legacy)
 *   - web+stellar:pay?destination=G...&memo=...          (web QR component)
 *   - a raw Stellar public key, or any URL containing one
 *
 * Post-scan flow:
 *   scanning → validating → found   (green: project name, auto-navigate)
 *                         → unknown (yellow: address not in registry,
 *                                    donor may still donate to it)
 *                         → invalid (red: not a Stellar/IndigoPay QR)
 *
 * Every successful scan is persisted to AsyncStorage (last 20, newest
 * first) and surfaced in a "Recent scans" sheet for quick re-donation.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Linking,
  Platform,
  Modal,
  FlatList,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import axios from "axios";
import { parseQRData, ParsedQR } from "../utils/qrParser";
import {
  addToHistory,
  clearScanHistory,
  getScanHistory,
  ScanHistoryItem,
} from "../utils/scanHistory";

const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://localhost:4000";
const NAVIGATE_DELAY_MS = 800; // Brief pause so the success state is visible.

type ValidationState =
  | "scanning"
  | "validating"
  | "found"
  | "unknown"
  | "invalid";

interface RegistryProject {
  id: string;
  name: string;
  walletAddress: string;
}

/** Look up a scanned wallet address in the backend project registry. */
async function lookupAddress(
  address: string,
): Promise<{ found: boolean; project?: RegistryProject }> {
  try {
    const res = await axios.get(
      `${API_URL}/api/projects?wallet=${encodeURIComponent(address)}`,
    );
    const list: RegistryProject[] = Array.isArray(res.data?.data)
      ? res.data.data
      : [];
    const project = list.find((p) => p.walletAddress === address);
    return { found: !!project, project };
  } catch {
    return { found: false };
  }
}

export default function ScanScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [validationState, setValidationState] =
    useState<ValidationState>("scanning");
  const [projectInfo, setProjectInfo] = useState<RegistryProject | null>(null);
  const [pendingScan, setPendingScan] = useState<ParsedQR | null>(null);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [history, setHistory] = useState<ScanHistoryItem[]>([]);
  const cooldown = useRef(false);
  const navigateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!permission?.granted) {
      requestPermission();
    }
  }, []);

  useEffect(() => {
    return () => {
      if (navigateTimer.current) clearTimeout(navigateTimer.current);
    };
  }, []);

  const refreshHistory = useCallback(async () => {
    setHistory(await getScanHistory());
  }, []);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  const resetScanner = () => {
    if (navigateTimer.current) clearTimeout(navigateTimer.current);
    setValidationState("scanning");
    setProjectInfo(null);
    setPendingScan(null);
    cooldown.current = false;
  };

  const navigateToDonate = (
    projectId: string,
    params: { amount?: string; memo?: string; wallet?: string },
  ) => {
    const query = new URLSearchParams();
    if (params.amount) query.set("amount", params.amount);
    if (params.memo) query.set("memo", params.memo);
    if (params.wallet) query.set("wallet", params.wallet);
    const qs = query.toString();
    router.push(`/donate/${projectId}${qs ? `?${qs}` : ""}` as `${string}`);
  };

  const scheduleNavigate = (
    projectId: string,
    params: { amount?: string; memo?: string; wallet?: string },
  ) => {
    navigateTimer.current = setTimeout(() => {
      navigateToDonate(projectId, params);
    }, NAVIGATE_DELAY_MS);
  };

  const handleBarcode = async ({ data }: { data: string }) => {
    if (cooldown.current || validationState !== "scanning") return;
    cooldown.current = true;

    const parsed = parseQRData(data);

    if (parsed.type === "unknown") {
      setValidationState("invalid");
      return;
    }

    setValidationState("validating");
    setPendingScan(parsed);

    // Deep link with an embedded projectId: no registry lookup needed.
    if (parsed.type === "donate_link" && parsed.projectId) {
      setValidationState("found");
      await addToHistory({ ...parsed, timestamp: Date.now() });
      refreshHistory();
      scheduleNavigate(parsed.projectId, {
        amount: parsed.amount,
        memo: parsed.memo,
      });
      return;
    }

    // Otherwise validate the scanned address against the project registry.
    if (parsed.address) {
      const result = await lookupAddress(parsed.address);
      if (result.found && result.project) {
        setValidationState("found");
        setProjectInfo(result.project);
        await addToHistory({
          ...parsed,
          projectId: result.project.id,
          projectName: result.project.name,
          timestamp: Date.now(),
        });
        refreshHistory();
        scheduleNavigate(result.project.id, {
          amount: parsed.amount,
          memo: parsed.memo,
        });
      } else {
        setValidationState("unknown");
      }
      return;
    }

    setValidationState("invalid");
  };

  /** "Donate anyway" for addresses that aren't in the project registry. */
  const donateToUnknownAddress = async () => {
    if (!pendingScan?.address) return;
    await addToHistory({ ...pendingScan, timestamp: Date.now() });
    refreshHistory();
    navigateToDonate("scan", {
      wallet: pendingScan.address,
      amount: pendingScan.amount,
      memo: pendingScan.memo,
    });
  };

  const openHistoryItem = (item: ScanHistoryItem) => {
    setHistoryVisible(false);
    if (item.projectId) {
      navigateToDonate(item.projectId, {
        amount: item.amount,
        memo: item.memo,
      });
    } else if (item.address) {
      navigateToDonate("scan", {
        wallet: item.address,
        amount: item.amount,
        memo: item.memo,
      });
    }
  };

  const handleClearHistory = async () => {
    await clearScanHistory();
    refreshHistory();
  };

  if (!permission) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>Requesting camera permission…</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>
          Camera access is required to scan QR codes.
        </Text>
        <TouchableOpacity style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Grant Permission</Text>
        </TouchableOpacity>
        {Platform.OS !== "web" && (
          <TouchableOpacity
            style={[styles.button, styles.buttonSecondary]}
            onPress={() => Linking.openSettings()}
          >
            <Text style={styles.buttonText}>Open Settings</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        onBarcodeScanned={
          validationState === "scanning" ? handleBarcode : undefined
        }
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
      />

      {/* Viewfinder overlay */}
      <View style={styles.overlay}>
        <View style={styles.topOverlay} />
        <View style={styles.middleRow}>
          <View style={styles.sideOverlay} />
          <View style={styles.viewfinder}>
            <View style={[styles.corner, styles.topLeft]} />
            <View style={[styles.corner, styles.topRight]} />
            <View style={[styles.corner, styles.bottomLeft]} />
            <View style={[styles.corner, styles.bottomRight]} />
          </View>
          <View style={styles.sideOverlay} />
        </View>
        <View style={styles.bottomOverlay}>
          {validationState === "scanning" && (
            <Text style={styles.hint}>
              Point the camera at a project wallet QR code
            </Text>
          )}

          {validationState === "validating" && (
            <View style={styles.statusRow}>
              <ActivityIndicator color="#c8e6c9" />
              <Text style={[styles.hint, styles.statusRowText]}>
                Validating scanned code…
              </Text>
            </View>
          )}

          {validationState === "found" && (
            <View style={styles.statusCard}>
              <Text style={styles.foundIcon}>✅</Text>
              <Text style={styles.successText}>
                {projectInfo?.name
                  ? `${projectInfo.name} verified`
                  : "IndigoPay project QR verified"}
              </Text>
              {pendingScan?.amount ? (
                <Text style={styles.successSubText}>
                  Suggested amount: {pendingScan.amount} XLM
                </Text>
              ) : null}
              <Text style={styles.successSubText}>Opening donation…</Text>
            </View>
          )}

          {validationState === "unknown" && (
            <View style={styles.statusCard}>
              <Text style={styles.foundIcon}>⚠️</Text>
              <Text style={styles.warningText}>
                Address not in the project registry.
              </Text>
              <Text style={styles.warningSubText}>
                {pendingScan?.address
                  ? `${pendingScan.address.slice(0, 8)}…${pendingScan.address.slice(-4)}`
                  : ""}
              </Text>
              <TouchableOpacity
                style={[styles.button, { marginTop: 12 }]}
                onPress={donateToUnknownAddress}
                accessibilityRole="button"
                accessibilityLabel="Donate to this address anyway"
              >
                <Text style={styles.buttonText}>Donate Anyway</Text>
              </TouchableOpacity>
            </View>
          )}

          {validationState === "invalid" && (
            <View style={styles.statusCard}>
              <Text style={styles.foundIcon}>❌</Text>
              <Text style={styles.errorText}>
                Not a valid Stellar address or IndigoPay QR code.
              </Text>
            </View>
          )}

          {validationState !== "scanning" &&
            validationState !== "validating" && (
              <TouchableOpacity
                style={[styles.button, styles.buttonSecondary, { marginTop: 16 }]}
                onPress={resetScanner}
                accessibilityRole="button"
                accessibilityLabel="Scan another QR code"
              >
                <Text style={styles.buttonText}>Scan Again</Text>
              </TouchableOpacity>
            )}

          <TouchableOpacity
            style={styles.historyLink}
            onPress={() => {
              refreshHistory();
              setHistoryVisible(true);
            }}
            accessibilityRole="button"
            accessibilityLabel="Show recent scans"
          >
            <Text style={styles.historyLinkText}>
              🕘 Recent scans{history.length ? ` (${history.length})` : ""}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Scan history sheet */}
      <Modal
        visible={historyVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setHistoryVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Recent scans</Text>
              <TouchableOpacity
                onPress={() => setHistoryVisible(false)}
                accessibilityRole="button"
                accessibilityLabel="Close recent scans"
              >
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {history.length === 0 ? (
              <Text style={styles.emptyHistory}>
                No scans yet. Scanned QR codes will show up here for quick
                re-donation.
              </Text>
            ) : (
              <FlatList
                data={history}
                keyExtractor={(item) => `${item.raw}-${item.timestamp}`}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.historyItem}
                    onPress={() => openHistoryItem(item)}
                    accessibilityRole="button"
                    accessibilityLabel={`Donate again to ${item.projectName || item.address || "scanned code"}`}
                  >
                    <Text style={styles.historyItemTitle}>
                      {item.projectName ||
                        (item.address
                          ? `${item.address.slice(0, 8)}…${item.address.slice(-4)}`
                          : "IndigoPay QR")}
                    </Text>
                    <Text style={styles.historyItemMeta}>
                      {item.amount ? `${item.amount} XLM · ` : ""}
                      {new Date(item.timestamp).toLocaleString()}
                    </Text>
                  </TouchableOpacity>
                )}
              />
            )}

            {history.length > 0 && (
              <TouchableOpacity
                style={styles.clearHistoryButton}
                onPress={handleClearHistory}
                accessibilityRole="button"
                accessibilityLabel="Clear scan history"
              >
                <Text style={styles.clearHistoryText}>Clear history</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const CORNER = 24;
const BORDER = 3;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
    backgroundColor: "#f0f7f0",
  },
  message: {
    fontSize: 16,
    color: "#1a2e1a",
    textAlign: "center",
    marginBottom: 20,
  },
  button: {
    backgroundColor: "#227239",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 8,
  },
  buttonSecondary: {
    backgroundColor: "#5a7a5a",
  },
  buttonText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: "column",
  },
  topOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  middleRow: {
    flexDirection: "row",
    height: 260,
  },
  sideOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  viewfinder: {
    width: 260,
    height: 260,
  },
  bottomOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    paddingTop: 20,
    paddingHorizontal: 24,
  },
  hint: {
    color: "#c8e6c9",
    fontSize: 14,
    textAlign: "center",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  statusRowText: {
    marginLeft: 10,
  },
  statusCard: {
    alignItems: "center",
  },
  foundIcon: {
    fontSize: 28,
    marginBottom: 6,
  },
  errorText: {
    color: "#ff8a80",
    fontSize: 14,
    textAlign: "center",
  },
  warningText: {
    color: "#ffe082",
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
  },
  warningSubText: {
    color: "#ffecb3",
    fontSize: 12,
    marginTop: 4,
    textAlign: "center",
  },
  successText: {
    color: "#a5d6a7",
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center",
  },
  successSubText: {
    color: "#c8e6c9",
    fontSize: 13,
    marginTop: 4,
    textAlign: "center",
  },
  historyLink: {
    marginTop: 18,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  historyLinkText: {
    color: "#c8e6c9",
    fontSize: 14,
    fontWeight: "600",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 28,
    maxHeight: "70%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1a2e1a",
  },
  modalClose: {
    fontSize: 18,
    color: "#5a7a5a",
    padding: 4,
  },
  emptyHistory: {
    color: "#5a7a5a",
    fontSize: 14,
    paddingVertical: 20,
    textAlign: "center",
  },
  historyItem: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#e8f0e8",
  },
  historyItemTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: "#1a2e1a",
  },
  historyItemMeta: {
    fontSize: 12,
    color: "#5a7a5a",
    marginTop: 2,
  },
  clearHistoryButton: {
    marginTop: 14,
    alignSelf: "center",
    paddingVertical: 8,
    paddingHorizontal: 18,
  },
  clearHistoryText: {
    color: "#b23b3b",
    fontSize: 14,
    fontWeight: "600",
  },
});
