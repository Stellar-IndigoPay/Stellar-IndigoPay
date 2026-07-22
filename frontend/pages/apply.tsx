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
 * Uses react-hook-form for performant form state and zod for type-safe
 * schema validation, replacing the previous manual useState per field.
 *
 * The POST hits /api/verification-requests which the backend persists
 * to the verification_requests table and uses to email admins via
 * Resend. Backend behaviour lives in backend/src/routes/verification.js.
 */
import { useRef, useState } from "react";
import { useRouter } from "next/router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useI18n } from "@/lib/i18n";
import { PROJECT_CATEGORIES } from "@/utils/format";
import {
  submitVerificationRequest,
  uploadSupportingDocument,
  type VerificationDocument,
} from "@/lib/api";
import {
  verificationRequestSchema,
  type VerificationRequestFormData,
} from "@/lib/validation";
import FormField from "@/components/FormField";

type Step = "org" | "project" | "impact" | "documents" | "review" | "done";

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

/**
 * Field sets per step — used by `trigger()` to validate only the fields
 * visible in the current step before advancing.
 */
const STEP_FIELDS: Record<Exclude<Step, "review" | "done">, (keyof VerificationRequestFormData)[]> = {
  org: [
    "organizationName",
    "organizationWebsite",
    "organizationCountry",
    "contactEmail",
    "walletAddress",
  ],
  project: [
    "projectName",
    "projectCategory",
    "projectLocation",
    "projectDescription",
  ],
  impact: ["co2PerXLM", "expectedAnnualTonnesCO2", "notes"],
  documents: [],
};

export default function ApplyPage() {
  const router = useRouter();
  const { t } = useI18n();
  const T = (key: string) => (t(`apply.${key}`) as string) || key;

  const [step, setStep] = useState<Step>("org");
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState("");
  const [reviewTimeline, setReviewTimeline] = useState("5–10 business days");
  const [documents, setDocuments] = useState<VerificationDocument[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const {
    register,
    handleSubmit,
    trigger,
    getValues,
    formState: { errors },
  } = useForm<VerificationRequestFormData>({
    resolver: zodResolver(verificationRequestSchema),
    defaultValues: {
      projectCategory: PROJECT_CATEGORIES[0],
      organizationWebsite: "",
      organizationCountry: "",
      projectDescription: "",
      expectedAnnualTonnesCO2: "",
      notes: "",
    },
    mode: "onTouched",
  });

  async function validateAndNext() {
    const stepFields = STEP_FIELDS[step as keyof typeof STEP_FIELDS];
    if (!stepFields || stepFields.length === 0) {
      // Documents step has no validated fields — just advance
      const idx = STEPS.indexOf(step);
      if (idx < STEPS.length - 2) setStep(STEPS[idx + 1]);
      return;
    }

    const valid = await trigger(stepFields as any);
    if (!valid) return;

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

  async function onSubmit(data: VerificationRequestFormData) {
    setSubmitting(true);
    setServerError("");
    try {
      const payload = {
        organizationName: data.organizationName.trim(),
        organizationWebsite: data.organizationWebsite?.trim() || undefined,
        organizationCountry: data.organizationCountry?.trim() || undefined,
        contactEmail: data.contactEmail.trim(),
        walletAddress: data.walletAddress.trim(),
        projectName: data.projectName.trim(),
        projectCategory: data.projectCategory,
        projectLocation: data.projectLocation.trim(),
        projectDescription: data.projectDescription?.trim() || undefined,
        co2PerXLM: data.co2PerXLM.trim(),
        expectedAnnualTonnesCO2:
          data.expectedAnnualTonnesCO2?.trim() || undefined,
        supportingDocuments: documents,
        notes: data.notes?.trim() || undefined,
      };
      const result = await submitVerificationRequest(payload);
      setReviewTimeline(result?.reviewTimeline ?? "5–10 business days");
      setStep("done");
    } catch (err: any) {
      const msg =
        err?.response?.data?.error ??
        err?.response?.data?.message ??
        "Submission failed. Please try again.";
      setServerError(msg);
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
            .replace("{email}", getValues("contactEmail") ?? "")}
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

      <form
        onSubmit={handleSubmit(onSubmit)}
        noValidate
      >
        <div className="card p-6 space-y-5">
          {/* Step: org */}
          {step === "org" && (
            <>
              <h2 className="font-display text-xl font-bold text-[#0F172A] dark:text-[#E2E8F0]">
                {T("stepOrg")}
              </h2>
              <FormField
                label={T("orgName")}
                required
                error={errors.organizationName?.message}
                placeholder="Acme Climate Foundation"
                {...register("organizationName")}
              />
              <FormField
                label={T("orgWebsite")}
                error={errors.organizationWebsite?.message}
                placeholder="https://acme.org"
                {...register("organizationWebsite")}
              />
              <FormField
                label={T("orgCountry")}
                error={errors.organizationCountry?.message}
                placeholder="Kenya"
                {...register("organizationCountry")}
              />
              <FormField
                label={T("contactEmail")}
                required
                type="email"
                error={errors.contactEmail?.message}
                placeholder="hello@acme.org"
                {...register("contactEmail")}
              />
              <FormField
                label={T("walletAddress")}
                required
                hint={T("walletHelper")}
                error={errors.walletAddress?.message}
                placeholder="GABC…"
                spellCheck={false}
                {...register("walletAddress")}
              />
            </>
          )}

          {/* Step: project */}
          {step === "project" && (
            <>
              <h2 className="font-display text-xl font-bold text-[#0F172A] dark:text-[#E2E8F0]">
                {T("stepProject")}
              </h2>
              <FormField
                label={T("projectName")}
                required
                error={errors.projectName?.message}
                placeholder="Acme Solar Farm Phase 1"
                {...register("projectName")}
              />
              <FormField
                as="select"
                label={T("projectCategory")}
                required
                error={errors.projectCategory?.message}
                {...register("projectCategory")}
              >
                {PROJECT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </FormField>
              <FormField
                label={T("projectLocation")}
                required
                error={errors.projectLocation?.message}
                placeholder="Nairobi, Kenya"
                {...register("projectLocation")}
              />
              <FormField
                as="textarea"
                label={T("projectDescription")}
                error={errors.projectDescription?.message}
                placeholder="Tell us about the project in a few sentences."
                {...register("projectDescription")}
              />
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
                label={T("co2PerXLM")}
                required
                error={errors.co2PerXLM?.message}
                hint="e.g. 0.05 kg CO₂ per XLM."
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                placeholder="0.05"
                {...register("co2PerXLM")}
              />
              <FormField
                label={T("annualTonnes")}
                error={errors.expectedAnnualTonnesCO2?.message}
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                placeholder="1200"
                {...register("expectedAnnualTonnesCO2")}
              />
              <FormField
                as="textarea"
                label={T("notes")}
                error={errors.notes?.message}
                placeholder="Methodology, prior funding rounds, anything else the reviewer should see."
                {...register("notes")}
              />
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
          {step === "review" && (() => {
            const reviewData = getValues();
            return (
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
                    {reviewData.organizationName || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[#64748B] dark:text-[#94A3B8] uppercase tracking-wider">
                    {T("contactEmail")}
                  </dt>
                  <dd className="text-forest-900 break-all">
                    {reviewData.contactEmail || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[#64748B] dark:text-[#94A3B8] uppercase tracking-wider">
                    {T("walletAddress")}
                  </dt>
                  <dd className="font-mono text-xs text-[#0F172A] dark:text-[#E2E8F0] break-all">
                    {reviewData.walletAddress || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[#64748B] dark:text-[#94A3B8] uppercase tracking-wider">
                    {T("projectName")}
                  </dt>
                  <dd className="text-[#0F172A] dark:text-[#E2E8F0]">
                    {reviewData.projectName || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[#64748B] dark:text-[#94A3B8] uppercase tracking-wider">
                    {T("projectCategory")}
                  </dt>
                  <dd className="text-[#0F172A] dark:text-[#E2E8F0]">
                    {reviewData.projectCategory || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[#64748B] dark:text-[#94A3B8] uppercase tracking-wider">
                    {T("projectLocation")}
                  </dt>
                  <dd className="text-[#0F172A] dark:text-[#E2E8F0]">
                    {reviewData.projectLocation || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[#64748B] dark:text-[#94A3B8] uppercase tracking-wider">
                    {T("co2PerXLM")}
                  </dt>
                  <dd className="text-[#0F172A] dark:text-[#E2E8F0]">
                    {reviewData.co2PerXLM || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[#64748B] dark:text-[#94A3B8] uppercase tracking-wider">
                    {T("annualTonnes")}
                  </dt>
                  <dd className="text-[#0F172A] dark:text-[#E2E8F0]">
                    {reviewData.expectedAnnualTonnesCO2 || "—"}
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
            );
          })()}
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
            <button
              type="button"
              onClick={validateAndNext}
              className="btn-primary"
            >
              {T("common.next") || "Next"}
            </button>
          ) : step === "review" ? (
            <button
              type="submit"
              disabled={submitting}
              className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? T("submitting") : T("submit")}
            </button>
          ) : (
            <button
              type="button"
              onClick={validateAndNext}
              className="btn-primary"
            >
              {T("common.next") || "Next"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
