import { useState } from "react";
import { useRouter } from "next/router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { notifyAdmin, submitProject } from "@/lib/api";
import { PROJECT_CATEGORIES } from "@/utils/format";
import {
  submitProjectSchema,
  type SubmitProjectFormData,
} from "@/lib/validation";
import FormField from "@/components/FormField";

type Step = "org" | "project" | "wallet" | "methodology" | "done";

const STEPS: Step[] = ["org", "project", "wallet", "methodology", "done"];
const STEP_LABELS: Record<Step, string> = {
  org: "Organization",
  project: "Project Details",
  wallet: "Wallet",
  methodology: "CO₂ Methodology",
  done: "Submitted",
};

const IMPACT_METRICS_OPTIONS = [
  { label: "CO₂ Reduction", value: "co2-reduction" },
  { label: "Tree Planting", value: "tree-planting" },
  { label: "Community Jobs", value: "community-jobs" },
];

/**
 * Field sets per step — used by `trigger()` to validate only the fields
 * visible in the current step before advancing.
 */
const STEP_FIELDS: Record<
  Exclude<Step, "methodology" | "done">,
  (keyof SubmitProjectFormData | `${string}.${string}`)[]
> = {
  org: [
    "organization.name",
    "organization.website",
    "organization.country",
    "organization.contactEmail",
  ],
  project: ["name", "category", "description", "location", "goalXLM"],
  wallet: ["walletAddress"],
};

export default function SubmitProjectPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("org");
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState("");
  const [reviewTimeline, setReviewTimeline] = useState("");

  const {
    register,
    handleSubmit,
    trigger,
    getValues,
    watch,
    setValue,
    formState: { errors },
  } = useForm<SubmitProjectFormData>({
    resolver: zodResolver(submitProjectSchema),
    defaultValues: {
      category: PROJECT_CATEGORIES[0],
      organization: {
        name: "",
        website: "",
        country: "",
        contactEmail: "",
      },
      co2Methodology: {
        name: "",
        verificationBody: "",
        annualTonnesCO2: "",
        documentUrl: "",
      },
      impactMetrics: [],
    },
    mode: "onTouched",
  });

  const impactMetrics = watch("impactMetrics");

  const toggleImpactMetric = (value: string) => {
    const current = impactMetrics ?? [];
    const updated = current.includes(value)
      ? current.filter((m) => m !== value)
      : [...current, value];
    setValue("impactMetrics", updated);
  };

  // Build flattened error paths for nested objects
  const getFieldError = (
    parent: "organization" | "co2Methodology",
    field: string,
  ): string | undefined => {
    const parentErrors =
      errors[parent] as
        | Record<string, { message?: string }>
        | undefined;
    return parentErrors?.[field]?.message;
  };

  async function validateAndNext() {
    const stepFields = STEP_FIELDS[step as keyof typeof STEP_FIELDS];
    if (!stepFields || stepFields.length === 0) {
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

  async function onSubmit(data: SubmitProjectFormData) {
    setSubmitting(true);
    setServerError("");
    try {
      const payload = {
        name: data.name,
        category: data.category,
        description: data.description,
        location: data.location,
        goalXLM: data.goalXLM,
        walletAddress: data.walletAddress.trim(),
        organization: {
          name: data.organization.name,
          website: data.organization.website,
          country: data.organization.country,
          contactEmail: data.organization.contactEmail,
        },
        co2Methodology: {
          name: data.co2Methodology.name,
          verificationBody: data.co2Methodology.verificationBody,
          annualTonnesCO2: data.co2Methodology.annualTonnesCO2,
          documentUrl: data.co2Methodology.documentUrl,
        },
        impactMetrics: data.impactMetrics,
      };
      const result = await submitProject(payload);
      setReviewTimeline(result?.reviewTimeline ?? "5–10 business days");
      try {
        await notifyAdmin({
          projectName: data.name,
          contactEmail: data.organization.contactEmail,
          impactMetrics: data.impactMetrics,
        });
      } catch {
        // Best-effort admin notification; the success state should still render.
      }
      setStep("done");
    } catch (err: any) {
      const msg =
        err?.response?.data?.message ??
        err?.response?.data?.error ??
        "Submission failed. Please try again.";
      setServerError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  const stepIndex = STEPS.indexOf(step);
  const progressSteps = STEPS.slice(0, -1);

  if (step === "done") {
    const doneData = getValues();
    return (
      <div className="max-w-xl mx-auto px-4 py-20 text-center animate-fade-in">
        <div className="text-6xl mb-6">🌿</div>
        <h1 className="font-display text-3xl font-bold text-forest-900 mb-3">
          Project Submitted!
        </h1>
        <p className="text-[#5a7a5a] dark:text-[#8aaa8a] font-body mb-2">
          Thank you for submitting <strong>{doneData.name}</strong>.
        </p>
        <p className="text-[#5a7a5a] dark:text-[#8aaa8a] font-body mb-8">
          Our team will review your submission within{" "}
          <strong>{reviewTimeline || "5–10 business days"}</strong>. We&apos;ll
          contact you at{" "}
          <strong>{doneData.organization?.contactEmail}</strong> with the
          outcome.
        </p>
        <button
          className="btn-primary"
          onClick={() => router.push("/projects")}
        >
          Browse Projects
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-10 animate-fade-in">
      <h1 className="font-display text-3xl font-bold text-forest-900 mb-2">
        Submit Your Project
      </h1>
      <p className="text-[#5a7a5a] dark:text-[#8aaa8a] font-body mb-8 text-sm">
        Organizations can submit climate projects for verification and funding
        on Stellar IndigoPay.
      </p>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-10">
        {progressSteps.map((s, i) => (
          <div key={s} className="flex items-center gap-2 flex-1">
            <div
              className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-colors ${
                i < stepIndex
                  ? "bg-emerald-600 border-emerald-600 text-white"
                  : i === stepIndex
                    ? "border-emerald-600 text-emerald-700 bg-white"
                    : "border-forest-200 text-[#8aaa8a] dark:text-forest-300 bg-white"
              }`}
            >
              {i < stepIndex ? "✓" : i + 1}
            </div>
            <span
              className={`text-xs font-body hidden sm:block ${
                i === stepIndex
                  ? "text-forest-900 font-semibold"
                  : "text-[#8aaa8a] dark:text-forest-300"
              }`}
            >
              {STEP_LABELS[s]}
            </span>
            {i < progressSteps.length - 1 && (
              <div
                className={`flex-1 h-px ${i < stepIndex ? "bg-emerald-400" : "bg-forest-200"}`}
              />
            )}
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <div className="card p-6 space-y-5">
          {/* Step: org */}
          {step === "org" && (
            <>
              <h2 className="font-display text-xl font-bold text-forest-900">
                Organization Info
              </h2>
              <FormField
                label="Organization Name"
                required
                error={getFieldError("organization", "name")}
                placeholder="Acme Climate Foundation"
                {...register("organization.name")}
              />
              <FormField
                label="Website"
                error={getFieldError("organization", "website")}
                placeholder="https://acme.org"
                {...register("organization.website")}
              />
              <FormField
                label="Country"
                required
                error={getFieldError("organization", "country")}
                placeholder="Kenya"
                {...register("organization.country")}
              />
              <FormField
                label="Contact Email"
                required
                type="email"
                error={getFieldError("organization", "contactEmail")}
                placeholder="hello@acme.org"
                {...register("organization.contactEmail")}
              />
            </>
          )}

          {/* Step: project */}
          {step === "project" && (
            <>
              <h2 className="font-display text-xl font-bold text-forest-900">
                Project Details
              </h2>
              <FormField
                label="Project Name"
                required
                error={errors.name?.message}
                placeholder="Acme Solar Farm Phase 1"
                {...register("name")}
              />
              <FormField
                as="select"
                label="Category"
                required
                error={errors.category?.message}
                {...register("category")}
              >
                {PROJECT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </FormField>
              <FormField
                as="textarea"
                label="Description"
                required
                error={errors.description?.message}
                placeholder="Describe the project's goals, impact, and methods…"
                {...register("description")}
              />
              <FormField
                label="Location"
                required
                error={errors.location?.message}
                placeholder="Nairobi, Kenya"
                {...register("location")}
              />
              <FormField
                label="Funding Goal (XLM)"
                required
                type="number"
                min="1"
                step="any"
                error={errors.goalXLM?.message}
                placeholder="50000"
                {...register("goalXLM")}
              />
            </>
          )}

          {/* Step: wallet */}
          {step === "wallet" && (
            <>
              <h2 className="font-display text-xl font-bold text-forest-900">
                Stellar Wallet
              </h2>
              <p className="text-sm text-[#5a7a5a] dark:text-[#8aaa8a] font-body">
                Donations will be sent directly to this Stellar address. Make
                sure you control it.
              </p>
              <FormField
                label="Stellar Wallet Address"
                required
                error={errors.walletAddress?.message}
                placeholder="GABC…"
                spellCheck={false}
                {...register("walletAddress")}
              />
              <p className="text-xs text-[#8aaa8a] dark:text-forest-300 font-body">
                Starts with G and is 56 characters long. Testnet and mainnet
                addresses are both accepted.
              </p>
            </>
          )}

          {/* Step: methodology */}
          {step === "methodology" && (
            <>
              <h2 className="font-display text-xl font-bold text-forest-900">
                CO₂ Methodology
              </h2>
              <p className="text-sm text-[#5a7a5a] dark:text-[#8aaa8a] font-body">
                Tell us how your project measures and verifies carbon reduction.
              </p>
              <FormField
                label="Methodology Name"
                required
                error={getFieldError("co2Methodology", "name")}
                placeholder="Verra VM0007"
                {...register("co2Methodology.name")}
              />
              <FormField
                label="Verification Body"
                required
                error={getFieldError("co2Methodology", "verificationBody")}
                placeholder="Gold Standard, Verra, etc."
                {...register("co2Methodology.verificationBody")}
              />
              <FormField
                label="Annual CO₂ Reduction (tonnes)"
                required
                type="number"
                min="1"
                step="any"
                error={getFieldError("co2Methodology", "annualTonnesCO2")}
                placeholder="1200"
                {...register("co2Methodology.annualTonnesCO2")}
              />
              <FormField
                label="Supporting Document URL"
                error={getFieldError("co2Methodology", "documentUrl")}
                placeholder="https://…"
                {...register("co2Methodology.documentUrl")}
              />

              <FormField label="Impact Metrics">
                <div className="flex flex-col gap-2 rounded-xl border border-[rgba(34,114,57,0.12)] bg-[#f8fcf8] p-3">
                  {IMPACT_METRICS_OPTIONS.map((metric) => (
                    <label
                      key={metric.value}
                      className="flex items-center gap-2 text-sm text-[#5a7a5a] cursor-pointer font-body"
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-[#8aaa8a] text-emerald-600 focus:ring-emerald-500"
                        checked={(impactMetrics ?? []).includes(metric.value)}
                        onChange={() => toggleImpactMetric(metric.value)}
                        aria-label={metric.label}
                      />
                      <span>{metric.label}</span>
                    </label>
                  ))}
                </div>
              </FormField>

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
            Back
          </button>

          {step === "methodology" ? (
            <button
              type="submit"
              disabled={submitting}
              className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? "Submitting…" : "Submit Project"}
            </button>
          ) : (
            <button
              type="button"
              onClick={validateAndNext}
              className="btn-primary"
            >
              Next
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
