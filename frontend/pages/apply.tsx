/**
 * pages/apply.tsx — Project Verification Request form
 *
 * Climate organisations visit /apply to submit a project for IndigoPay
 * verification. The form is structured as a multi-step wizard so the
 * most error-prone fields (wallet address, expected CO₂ offset, file
 * uploads) get dedicated steps. Documents upload as they are added;
 * the wizard stores their `url` returned by POST /api/uploads and sends
 * them in `supportingDocuments[]` on the final POST.
 *
 * The POST hits /api/verification-requests which the backend persists
 * to the verification_requests table and uses to email admins via
 * Resend. Backend behaviour lives in backend/src/routes/verification.js.
 */
import { useRef, useState } from "react";
import { useRouter } from "next/router";
import { useI18n } from "@/lib/i18n";
import { PROJECT_CATEGORIES } from "@/utils/format";
import {
  submitVerificationRequest,
  uploadSupportingDocument,
  type VerificationDocument,
} from "@/lib/api";
import FormField from "@/components/FormField";
import { useFormValidation } from "@/hooks/useFormValidation";
import { verificationRequestSchema } from "@/lib/validation/schemas";
import { z } from "zod";

type Step = "org" | "project" | "impact" | "documents" | "review" | "done";

interface FormData {
  organizationName: string;
  organizationWebsite: string;
  organizationCountry: string;
  contactEmail: string;
  walletAddress: string;
  projectName: string;
  projectCategory: string;
  projectLocation: string;
  projectDescription: string;
  co2PerXLM: string;
  expectedAnnualTonnesCO2: string;
  notes: string;
}

const STEPS: Step[] = [
  "org",
  "project",
  "impact",
  "documents",
  "review",
  "done",
];
const STEP_LABELS: Record<Step, string> = {
  org: "Organisation",
  project: "Project",
  impact: "Impact",
  documents: "Documents",
  review: "Submit",
  done: "Done",
};

const ACCEPTED_DOC_TYPES =
  ".pdf,.png,.jpg,.jpeg,.webp,.gif,.doc,.docx,.xls,.xlsx,.txt,.csv,.zip";

export default function ApplyPage() {
  const router = useRouter();
  const { t } = useI18n();
  const T = (key: string) => (t(`apply.${key}`) as string) || key;

  const [step, setStep] = useState<Step>("org");
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState("");
  const [reviewTimeline, setReviewTimeline] = useState("5–10 business days");
  const orgStepSchema = z.object({
    organizationName: z.string().min(1, "required"),
    organizationWebsite: z.string().url("invalidUrl").optional().or(z.literal("")),
    organizationCountry: z.string().optional(),
    contactEmail: z.string().email("invalidEmail"),
    walletAddress: z.string().regex(/^G[A-Z2-7]{55}$/, "invalidWallet"),
  });

  const projectStepSchema = z.object({
    projectName: z.string().min(1, "required"),
    projectCategory: z.enum(PROJECT_CATEGORIES as [string, ...string[]], {
      message: "invalidCategory",
    }),
    projectLocation: z.string().min(1, "required"),
    projectDescription: z.string().optional(),
  });

  const impactStepSchema = z.object({
    co2PerXLM: z.string().refine(
      (val) => {
        const n = Number(val);
        return val !== "" && Number.isFinite(n) && n >= 0;
      },
      { message: "invalidCO2" }
    ),
    expectedAnnualTonnesCO2: z.string().refine(
      (val) => {
        if (val === "") return true;
        const n = Number(val);
        return Number.isFinite(n) && n >= 0;
      },
      { message: "invalidCO2" }
    ).optional(),
    notes: z.string().optional(),
  });

  const orgValidation = useFormValidation(orgStepSchema);
  const projectValidation = useFormValidation(projectStepSchema);
  const impactValidation = useFormValidation(impactStepSchema);

  const currentValidation =
    step === "org"
      ? orgValidation
      : step === "project"
        ? projectValidation
        : step === "impact"
          ? impactValidation
          : null;

  const fieldErrors = (currentValidation ? currentValidation.errors : {}) as Record<string, string | undefined>;

  const [documents, setDocuments] = useState<VerificationDocument[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [form, setForm] = useState<FormData>({
    organizationName: "",
    organizationWebsite: "",
    organizationCountry: "",
    contactEmail: "",
    walletAddress: "",
    projectName: "",
    projectCategory: PROJECT_CATEGORIES[0],
    projectLocation: "",
    projectDescription: "",
    co2PerXLM: "",
    expectedAnnualTonnesCO2: "",
    notes: "",
  });

  const set =
    (field: keyof FormData) =>
    (
      e: React.ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >,
    ) => {
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
      orgValidation.clearField(field as any);
      projectValidation.clearField(field as any);
      impactValidation.clearField(field as any);
    };

  function validateStep(): boolean {
    if (step === "org") {
      return orgValidation.validate({
        organizationName: form.organizationName,
        organizationWebsite: form.organizationWebsite,
        organizationCountry: form.organizationCountry,
        contactEmail: form.contactEmail,
        walletAddress: form.walletAddress,
      });
    }
    if (step === "project") {
      return projectValidation.validate({
        projectName: form.projectName,
        projectCategory: form.projectCategory,
        projectLocation: form.projectLocation,
        projectDescription: form.projectDescription,
      });
    }
    if (step === "impact") {
      return impactValidation.validate({
        co2PerXLM: form.co2PerXLM,
        expectedAnnualTonnesCO2: form.expectedAnnualTonnesCO2,
        notes: form.notes,
      });
    }
    return true;
  }

  function nextStep() {
    if (!validateStep()) return;
    const idx = STEPS.indexOf(step);
    if (idx < STEPS.length - 2) setStep(STEPS[idx + 1]);
  }

  function prevStep() {
    const idx = STEPS.indexOf(step);
    if (idx > 0) setStep(STEPS[idx - 1]);
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setUploadError(T("uploadFailed"));
      return;
    }
    setUploading(true);
    setUploadError("");
    try {
      const uploaded = await uploadSupportingDocument(file);
      setDocuments((prev) => [
        ...prev,
        {
          name: uploaded.originalName,
          url: uploaded.url,
          size: uploaded.size,
          contentType: uploaded.contentType,
          backend: uploaded.backend,
        },
      ]);
    } catch (_err) {
      setUploadError(T("uploadFailed"));
    } finally {
      setUploading(false);
      // Reset so the same file can be re-selected if removed earlier
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removeDocument(index: number) {
    setDocuments((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit() {
    if (!validateStep()) return;
    setSubmitting(true);
    setServerError("");
    try {
      const payload = {
        organizationName: form.organizationName.trim(),
        organizationWebsite: form.organizationWebsite.trim() || undefined,
        organizationCountry: form.organizationCountry.trim() || undefined,
        contactEmail: form.contactEmail.trim(),
        walletAddress: form.walletAddress.trim(),
        projectName: form.projectName.trim(),
        projectCategory: form.projectCategory,
        projectLocation: form.projectLocation.trim(),
        projectDescription: form.projectDescription.trim() || undefined,
        co2PerXLM: form.co2PerXLM.trim(),
        expectedAnnualTonnesCO2:
          form.expectedAnnualTonnesCO2.trim() || undefined,
        supportingDocuments: documents,
        notes: form.notes.trim() || undefined,
      };
      const data = await submitVerificationRequest(payload);
      setReviewTimeline(data?.reviewTimeline ?? "5–10 business days");
      setStep("done");
    } catch (err: any) {
      const msg =
        err?.response?.data?.error ??
        err?.response?.data?.message ??
        "Submission failed. Please try again.";
      setServerError(msg);
      // Don't move back to "review" if the API still wants the form filled —
      // surface the message so the submitter can correct and retry.
    } finally {
      setSubmitting(false);
    }
  }

  const stepIndex = STEPS.indexOf(step);
  const progressSteps = STEPS.slice(0, -1);

  if (step === "done") {
    return (
      <div className="max-w-xl mx-auto px-4 py-20 text-center animate-fade-in">
        <div className="text-6xl mb-6">🔍</div>
        <h1 className="font-display text-3xl font-bold text-forest-900 mb-3">
          {T("subThanks")}
        </h1>
        <p className="text-[#5a7a5a] font-body mb-8">
          {T("subCopy")
            .replace("{timeline}", reviewTimeline)
            .replace("{email}", form.contactEmail)}
        </p>
        <button className="btn-primary" onClick={() => router.push("/")}>
          {T("backToHome")}
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-10 animate-fade-in">
      <p className="text-xs uppercase tracking-widest text-forest-600 font-bold mb-2 font-body">
        {T("pageTitle")}
      </p>{" "}
      <h1 className="font-display text-3xl font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-2">
        {T("pageTitle")}
      </h1>
      <p className="text-[#475569] dark:text-[#94A3B8] font-body mb-8 text-sm">
        {T("pageIntro")}
      </p>
      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-10">
        {progressSteps.map((s, i) => (
          <div key={s} className="flex items-center gap-2 flex-1">
            <div
              className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-colors ${
                i < stepIndex
                  ? "bg-gradient-to-r from-[#4F46E5] to-[#7C3AED] border-0 text-white"
                  : i === stepIndex
                    ? "border-[#4F46E5] dark:border-[#818CF8] text-[#4F46E5] dark:text-[#818CF8] bg-white dark:bg-[#14142D]"
                    : "border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.20)] text-[#64748B] dark:text-[#94A3B8] bg-white dark:bg-[#14142D]"
              }`}
            >
              {i < stepIndex ? "✓" : i + 1}
            </div>
            <span
              className={`text-xs font-body hidden sm:block ${
                i === stepIndex
                  ? "text-[#0F172A] dark:text-[#E2E8F0] font-semibold"
                  : "text-[#64748B] dark:text-[#94A3B8]"
              }`}
            >
              {STEP_LABELS[s]}
            </span>
            {i < progressSteps.length - 1 && (
              <div
                className={`flex-1 h-px ${i < stepIndex ? "bg-[#4F46E5] dark:bg-[#818CF8]" : "bg-[rgba(99,102,241,0.10)] dark:bg-[rgba(129,140,248,0.12)]"}`}
              />
            )}
          </div>
        ))}
      </div>
      <div className="card p-6 space-y-5">
        {/* Step: org */}
        {step === "org" && (
          <>
            <h2 className="font-display text-xl font-bold text-[#0F172A] dark:text-[#E2E8F0]">
              {T("stepOrg")}
            </h2>
            <FormField
              name="organizationName"
              label={`${T("orgName")} *`}
              error={fieldErrors.organizationName ? T(fieldErrors.organizationName) : undefined}
            >
              <input
                className="input-field"
                value={form.organizationName}
                onChange={set("organizationName")}
                placeholder="Acme Climate Foundation"
              />
            </FormField>
            <FormField
              name="organizationWebsite"
              label={T("orgWebsite")}
              error={fieldErrors.organizationWebsite ? T(fieldErrors.organizationWebsite) : undefined}
            >
              <input
                className="input-field"
                value={form.organizationWebsite}
                onChange={set("organizationWebsite")}
                placeholder="https://acme.org"
              />
            </FormField>
            <FormField
              name="organizationCountry"
              label={T("orgCountry")}
              error={fieldErrors.organizationCountry ? T(fieldErrors.organizationCountry) : undefined}
            >
              <input
                className="input-field"
                value={form.organizationCountry}
                onChange={set("organizationCountry")}
                placeholder="Kenya"
              />
            </FormField>
            <FormField
              name="contactEmail"
              label={`${T("contactEmail")} *`}
              error={fieldErrors.contactEmail ? T(fieldErrors.contactEmail) : undefined}
            >
              <input
                className="input-field"
                type="email"
                value={form.contactEmail}
                onChange={set("contactEmail")}
                placeholder="hello@acme.org"
              />
            </FormField>
            <FormField
              name="walletAddress"
              label={`${T("walletAddress")} *`}
              helper={T("walletHelper")}
              error={fieldErrors.walletAddress ? T(fieldErrors.walletAddress) : undefined}
            >
              <input
                className="input-field font-mono text-sm"
                spellCheck={false}
                value={form.walletAddress}
                onChange={set("walletAddress")}
                placeholder="GABC…"
              />
            </FormField>
          </>
        )}

        {/* Step: project */}
        {step === "project" && (
          <>
            <h2 className="font-display text-xl font-bold text-[#0F172A] dark:text-[#E2E8F0]">
              {T("stepProject")}
            </h2>
            <FormField
              name="projectName"
              label={`${T("projectName")} *`}
              error={fieldErrors.projectName ? T(fieldErrors.projectName) : undefined}
            >
              <input
                className="input-field"
                value={form.projectName}
                onChange={set("projectName")}
                placeholder="Acme Solar Farm Phase 1"
              />
            </FormField>
            <FormField
              name="projectCategory"
              label={`${T("projectCategory")} *`}
              error={fieldErrors.projectCategory ? T(fieldErrors.projectCategory) : undefined}
            >
              <select
                className="input-field"
                value={form.projectCategory}
                onChange={set("projectCategory")}
              >
                {PROJECT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField
              name="projectLocation"
              label={`${T("projectLocation")} *`}
              error={fieldErrors.projectLocation ? T(fieldErrors.projectLocation) : undefined}
            >
              <input
                className="input-field"
                value={form.projectLocation}
                onChange={set("projectLocation")}
                placeholder="Nairobi, Kenya"
              />
            </FormField>
            <FormField
              name="projectDescription"
              label={T("projectDescription")}
              error={fieldErrors.projectDescription ? T(fieldErrors.projectDescription) : undefined}
            >
              <textarea
                className="input-field min-h-[100px] resize-y"
                value={form.projectDescription}
                onChange={set("projectDescription")}
                placeholder="Tell us about the project in a few sentences."
              />
            </FormField>
          </>
        )}

        {/* Step: impact */}
        {step === "impact" && (
          <>
            <h2 className="font-display text-xl font-bold text-[#0F172A] dark:text-[#E2E8F0]">
              {T("stepImpact")}
            </h2>
            <p className="text-[#475569] dark:text-[#94A3B8] text-sm font-body">
              We use these numbers to communicate impact to donors and on-chain.
            </p>
            <FormField
              name="co2PerXLM"
              label={`${T("co2PerXLM")} *`}
              error={fieldErrors.co2PerXLM ? T(fieldErrors.co2PerXLM) : undefined}
              helper="e.g. 0.05 kg CO₂ per XLM."
            >
              <input
                className="input-field"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={form.co2PerXLM}
                onChange={set("co2PerXLM")}
                placeholder="0.05"
              />
            </FormField>
            <FormField
              name="expectedAnnualTonnesCO2"
              label={T("annualTonnes")}
              error={fieldErrors.expectedAnnualTonnesCO2 ? T(fieldErrors.expectedAnnualTonnesCO2) : undefined}
            >
              <input
                className="input-field"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={form.expectedAnnualTonnesCO2}
                onChange={set("expectedAnnualTonnesCO2")}
                placeholder="1200"
              />
            </FormField>
            <FormField
              name="notes"
              label={T("notes")}
              error={fieldErrors.notes ? T(fieldErrors.notes) : undefined}
            >
              <textarea
                className="input-field min-h-[80px] resize-y"
                value={form.notes}
                onChange={set("notes")}
                placeholder="Methodology, prior funding rounds, anything else the reviewer should see."
              />
            </FormField>
          </>
        )}

        {/* Step: documents */}
        {step === "documents" && (
          <>
            <h2 className="font-display text-xl font-bold text-[#0F172A] dark:text-[#E2E8F0]">
              {T("documentsTitle")}
            </h2>
            <p className="text-[#475569] dark:text-[#94A3B8] text-sm font-body">
              {T("documentsHint")}
            </p>
            <p className="text-xs text-[#64748B] dark:text-[#94A3B8] font-body">
              {T("storageNote")}
            </p>

            <div className="rounded-lg border border-dashed border-forest-200 p-4 flex flex-col gap-3 bg-forest-50/40">
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_DOC_TYPES}
                onChange={handleFileSelected}
                className="block w-full text-sm text-[#0F172A] dark:text-[#E2E8F0] file:mr-3 file:rounded-md file:border-0 file:bg-gradient-to-r file:from-[#4F46E5] file:to-[#7C3AED] file:px-4 file:py-2 file:text-white file:cursor-pointer hover:file:opacity-90"
                aria-label={T("documentsTitle")}
              />
              {uploading && (
                <p className="text-xs text-[#4F46E5] dark:text-[#818CF8] font-body">
                  {T("uploading")}
                </p>
              )}
              {uploadError && (
                <p className="text-xs text-red-500 font-body">{uploadError}</p>
              )}
            </div>

            {documents.length === 0 ? (
              <p className="text-sm text-[#64748B] dark:text-[#94A3B8] font-body">
                {T("noDocuments")}
              </p>
            ) : (
              <ul className="divide-y divide-forest-100 rounded-lg border border-forest-100 overflow-hidden">
                {documents.map((doc, i) => (
                  <li
                    key={`${doc.url}-${i}`}
                    className="flex items-center gap-3 px-4 py-3 bg-white dark:bg-[#14142D]"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[#0F172A] dark:text-[#E2E8F0] truncate font-body">
                        {doc.name}
                      </p>
                      <p className="text-xs text-[#64748B] dark:text-[#94A3B8] font-body truncate">
                        {doc.backend} ·{" "}
                        {doc.size ? `${(doc.size / 1024).toFixed(1)} KB` : "—"}
                      </p>
                    </div>
                    <a
                      href={doc.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-[#4F46E5] dark:text-[#818CF8] hover:underline font-body"
                    >
                      ↗
                    </a>
                    <button
                      type="button"
                      onClick={() => removeDocument(i)}
                      className="text-xs text-red-500 hover:text-red-600 font-body"
                    >
                      {T("remove")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {/* Step: review */}
        {step === "review" && (
          <>
            <h2 className="font-display text-xl font-bold text-[#0F172A] dark:text-[#E2E8F0]">
              {T("stepReview")}
            </h2>
            <p className="text-sm text-[#475569] dark:text-[#94A3B8] font-body">
              Quick scan before submission:
            </p>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm font-body">
              <div>
                <dt className="text-xs text-[#64748B] dark:text-[#94A3B8] uppercase tracking-wider">
                  {T("orgName")}
                </dt>
                <dd className="text-[#0F172A] dark:text-[#E2E8F0]">
                  {form.organizationName || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[#64748B] dark:text-[#94A3B8] uppercase tracking-wider">
                  {T("contactEmail")}
                </dt>
                <dd className="text-forest-900 break-all">
                  {form.contactEmail || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[#64748B] dark:text-[#94A3B8] uppercase tracking-wider">
                  {T("walletAddress")}
                </dt>
                <dd className="font-mono text-xs text-[#0F172A] dark:text-[#E2E8F0] break-all">
                  {form.walletAddress || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[#64748B] dark:text-[#94A3B8] uppercase tracking-wider">
                  {T("projectName")}
                </dt>
                <dd className="text-[#0F172A] dark:text-[#E2E8F0]">
                  {form.projectName || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[#64748B] dark:text-[#94A3B8] uppercase tracking-wider">
                  {T("projectCategory")}
                </dt>
                <dd className="text-[#0F172A] dark:text-[#E2E8F0]">
                  {form.projectCategory || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[#64748B] dark:text-[#94A3B8] uppercase tracking-wider">
                  {T("projectLocation")}
                </dt>
                <dd className="text-[#0F172A] dark:text-[#E2E8F0]">
                  {form.projectLocation || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[#64748B] dark:text-[#94A3B8] uppercase tracking-wider">
                  {T("co2PerXLM")}
                </dt>
                <dd className="text-[#0F172A] dark:text-[#E2E8F0]">
                  {form.co2PerXLM || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[#64748B] dark:text-[#94A3B8] uppercase tracking-wider">
                  {T("annualTonnes")}
                </dt>
                <dd className="text-[#0F172A] dark:text-[#E2E8F0]">
                  {form.expectedAnnualTonnesCO2 || "—"}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-[#64748B] dark:text-[#94A3B8] uppercase tracking-wider">
                  {T("documentsTitle")}
                </dt>
                <dd className="text-[#0F172A] dark:text-[#E2E8F0]">
                  {documents.length
                    ? documents.map((d) => d.name).join(", ")
                    : T("noDocuments")}
                </dd>
              </div>
            </dl>

            {serverError && (
              <p className="text-sm text-red-500 font-body">{serverError}</p>
            )}
          </>
        )}
      </div>
      {/* Navigation */}
      <div className="flex justify-between mt-6">
        <button
          type="button"
          onClick={prevStep}
          disabled={stepIndex === 0}
          className="btn-secondary disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {T("common.back") || "Back"}
        </button>

        {step === "documents" ? (
          <button type="button" onClick={nextStep} className="btn-primary">
            {T("common.next") || "Next"}
          </button>
        ) : step === "review" ? (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? T("submitting") : T("submit")}
          </button>
        ) : (
          <button type="button" onClick={nextStep} className="btn-primary">
            {T("common.next") || "Next"}
          </button>
        )}
      </div>
    </div>
  );
}
