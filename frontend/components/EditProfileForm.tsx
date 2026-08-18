import FormField from "@/components/FormField";
import { useFormValidation } from "@/hooks/useFormValidation";
import { profileSchema } from "@/lib/validation/schemas";
import { useState, useEffect } from "react";
import { fetchProfile, upsertProfile } from "@/lib/api";
import type { DonorProfile } from "@/utils/types";

interface EditProfileFormProps {
  publicKey: string;
}

export default function EditProfileForm({ publicKey }: EditProfileFormProps) {
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const { errors, validate, clearField } = useFormValidation(profileSchema);

  useEffect(() => {
    if (publicKey) {
      fetchProfile(publicKey)
        .then((p) => {
          if (p) {
            setDisplayName(p.displayName || "");
            setBio(p.bio || "");
          }
        })
        .catch(console.error);
    }
  }, [publicKey]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const isOk = validate({
      displayName,
      bio,
    });
    if (!isOk) return;

    setIsSaving(true);
    setMessage(null);

    try {
      await upsertProfile({
        publicKey,
        displayName: displayName.trim(),
        bio: bio.trim().slice(0, 200),
      });
      setMessage({
        type: "success",
        text: "Profile saved! Your name will now appear on the leaderboard.",
      });
    } catch (err) {
      console.error("Failed to save profile:", err);
      setMessage({
        type: "error",
        text: "Failed to save profile. Please try again.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="card shadow-sm border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)] p-6 md:p-8 bg-white/50 dark:bg-[#14142D]/50 backdrop-blur-sm">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-full bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.10)] flex items-center justify-center text-xl">
          👤
        </div>
        <h2 className="font-display text-xl font-bold text-[#0F172A] dark:text-[#E2E8F0]">
          Edit Profile
        </h2>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <FormField
          name="displayName"
          label="Display Name"
          error={errors.displayName}
        >
          <input
            type="text"
            className="input-field"
            placeholder="e.g. Alice_Green"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              clearField("displayName");
            }}
            maxLength={30}
          />
        </FormField>

        <FormField
          name="bio"
          label="Bio"
          error={errors.bio}
        >
          <textarea
            rows={3}
            className="w-full px-4 py-2.5 rounded-xl border border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.20)] font-body text-[#0F172A] dark:text-[#E2E8F0] focus:outline-none focus:ring-2 focus:ring-[rgba(99,102,241,0.15)] transition-all resize-none"
            placeholder="Tell us why you support climate projects..."
            value={bio}
            onChange={(e) => {
              setBio(e.target.value);
              clearField("bio");
            }}
            maxLength={200}
          />
        </FormField>
        <p className="mt-1.5 text-right text-[10px] text-[#64748B] dark:text-[#94A3B8] uppercase font-bold tracking-widest leading-none">
          {bio.length}/200
        </p>

        {message && (
          <div
            className={`p-4 rounded-xl flex items-center gap-3 animate-fade-in ${
              message.type === "success"
                ? "bg-emerald-50 text-emerald-700 border border-emerald-100"
                : "bg-red-50 text-red-700 border border-red-100"
            }`}
          >
            <span className="text-xl">
              {message.type === "success" ? "✅" : "⚠️"}
            </span>
            <p className="text-sm font-medium">{message.text}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={isSaving}
          className={`w-full btn-primary py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all ${
            isSaving
              ? "opacity-70 cursor-not-allowed scale-[0.98]"
              : "hover:scale-[1.01]"
          }`}
        >
          {isSaving ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Saving Profile...
            </>
          ) : (
            "Save Changes"
          )}
        </button>
      </form>
    </div>
  );
}
