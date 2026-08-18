import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  navigateToNotification,
  parseDeepLinkUrl,
  isNotificationHandled,
  getInboxNotifications,
  addInboxNotification,
  markInboxNotificationRead,
  markAllInboxNotificationsRead,
  clearInboxNotifications,
} from "../utils/notifications";
import * as Linking from "expo-linking";
import { Linking as RNLinking } from "react-native";

jest.mock("expo-linking", () => ({
  parse: jest.fn(),
}));

jest.mock("react-native", () => {
  const RN = jest.requireActual("react-native");
  RN.Linking.openURL = jest.fn().mockResolvedValue(true);
  return RN;
});

describe("Notification Utilities", () => {
  const mockPush = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    AsyncStorage.clear();
  });

  describe("parseDeepLinkUrl", () => {
    it("parses indigopay://project/123 -> /projects/123", () => {
      (Linking.parse as jest.Mock).mockReturnValueOnce({ path: "project/123" });
      const result = parseDeepLinkUrl("indigopay://project/123");
      expect(result).toBe("/projects/123");
      expect(Linking.parse).toHaveBeenCalledWith("indigopay://project/123");
    });

    it("parses indigopay://donate/456 -> /donate/456", () => {
      (Linking.parse as jest.Mock).mockReturnValueOnce({ path: "donate/456" });
      const result = parseDeepLinkUrl("indigopay://donate/456");
      expect(result).toBe("/donate/456");
    });

    it("returns null for invalid/unknown paths", () => {
      (Linking.parse as jest.Mock).mockReturnValueOnce({ path: "unknown/segment" });
      expect(parseDeepLinkUrl("indigopay://unknown/segment")).toBeNull();
    });
  });

  describe("navigateToNotification", () => {
    it("routes donation_receipt with donorAddress to profile", () => {
      navigateToNotification(
        { type: "donation_receipt", donorAddress: "0xABC", projectId: "proj-1" },
        mockPush,
      );
      expect(mockPush).toHaveBeenCalledWith("/profile/0xABC");
    });

    it("routes donation_receipt without donorAddress but with projectId to project", () => {
      navigateToNotification(
        { type: "donation_receipt", projectId: "proj-1" },
        mockPush,
      );
      expect(mockPush).toHaveBeenCalledWith("/projects/proj-1");
    });

    it("routes project_update and milestone_reached to projects screen", () => {
      navigateToNotification(
        { type: "project_update", projectId: "proj-1" },
        mockPush,
      );
      expect(mockPush).toHaveBeenCalledWith("/projects/proj-1");

      navigateToNotification(
        { type: "milestone_reached", projectId: "proj-2" },
        mockPush,
      );
      expect(mockPush).toHaveBeenCalledWith("/projects/proj-2");
    });

    it("routes subscription_due to donate screen", () => {
      navigateToNotification(
        { type: "subscription_due", projectId: "proj-3" },
        mockPush,
      );
      expect(mockPush).toHaveBeenCalledWith("/donate/proj-3");
    });

    it("falls back to home '/' for unknown/missing payloads", () => {
      navigateToNotification(undefined, mockPush);
      expect(mockPush).toHaveBeenCalledWith("/");

      mockPush.mockClear();
      navigateToNotification({ type: "unknown" }, mockPush);
      expect(mockPush).toHaveBeenCalledWith("/");
    });

    it("handles deep-link url in payload", () => {
      (Linking.parse as jest.Mock).mockReturnValueOnce({ path: "project/111" });
      navigateToNotification(
        { type: "unknown", url: "indigopay://project/111" },
        mockPush,
      );
      expect(mockPush).toHaveBeenCalledWith("/projects/111");
    });

    it("handles external web url using RN Linking.openURL", async () => {
      navigateToNotification(
        { type: "unknown", url: "https://example.com" },
        mockPush,
      );
      // Wait for dynamic import
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(RNLinking.openURL).toHaveBeenCalledWith("https://example.com");
    });
  });

  describe("isNotificationHandled (Duplicate Prevention)", () => {
    it("returns false for first check, true for duplicates", () => {
      const id = "notif-unique-123";
      expect(isNotificationHandled(id)).toBe(false);
      expect(isNotificationHandled(id)).toBe(true);
    });
  });

  describe("Local Inbox Notification Cache", () => {
    it("saves and retrieves notifications from AsyncStorage", async () => {
      const initial = await getInboxNotifications();
      expect(initial).toEqual([]);

      const mockNotif = {
        id: "id-1",
        type: "project_update",
        title: "Update",
        body: "A project updated",
        timestamp: Date.now(),
        read: false,
      };

      await addInboxNotification(mockNotif);
      const list = await getInboxNotifications();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe("id-1");
    });

    it("prevents adding duplicate IDs to the cache", async () => {
      const mockNotif = {
        id: "id-dup",
        type: "project_update",
        timestamp: Date.now(),
        read: false,
      };

      await addInboxNotification(mockNotif);
      await addInboxNotification(mockNotif);
      const list = await getInboxNotifications();
      expect(list).toHaveLength(1);
    });

    it("marks notifications as read", async () => {
      const mockNotif = {
        id: "id-read",
        type: "project_update",
        timestamp: Date.now(),
        read: false,
      };

      await addInboxNotification(mockNotif);
      await markInboxNotificationRead("id-read");
      const list = await getInboxNotifications();
      expect(list[0].read).toBe(true);
    });

    it("marks all notifications as read", async () => {
      await addInboxNotification({
        id: "1",
        type: "project_update",
        timestamp: Date.now(),
        read: false,
      });
      await addInboxNotification({
        id: "2",
        type: "project_update",
        timestamp: Date.now() - 1000,
        read: false,
      });

      await markAllInboxNotificationsRead();
      const list = await getInboxNotifications();
      expect(list.every((n) => n.read)).toBe(true);
    });

    it("clears all notifications from cache", async () => {
      await addInboxNotification({
        id: "1",
        type: "project_update",
        timestamp: Date.now(),
        read: false,
      });

      await clearInboxNotifications();
      const list = await getInboxNotifications();
      expect(list).toHaveLength(0);
    });
  });
});
