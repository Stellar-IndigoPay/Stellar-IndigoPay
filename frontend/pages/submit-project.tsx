import { useState } from "react";
import { useRouter } from "next/router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { notifyAdmin, submitProject } from "@/lib/api";
import { PROJECT_CATEGORIES } from "@/utils/format";
import FormField from "@/components/FormField";
import { useFormValidation } from "@/hooks/useFormValidation";
import { projectSubmissionSchema, walletAddressSchema, positiveNumberString } from "@/lib/validation/schemas";
import { z } from "zod";

type Step = "org" | "project" | "wallet" | "methodology" | "done";

const STEPS: Step[] = ["org", "project", "wallet", "methodology", "done"];
const STEP_LABELS: Record<Step, string> = {
  org: "Organization",
  project: "Project Details",
  wallet: "Wallet",
  methodology: "CO₂ Methodology",
  done: "Submitted",
};

const IMPACT_METRICS = [
  { label: "CO₂ Reduction", value: "co2-reduction" },
  { label: "Tree Planting", value: "tree-planting" },
  { label: "Community Jobs", value: "community-jobs" },
];

export default function SubmitProjectPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("org");
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState("");
  const [reviewTimeline, setReviewTimeline] = useState("");

  const orgStepSchema = z.object({
    orgName: z.string().min(1, "Required"),
    orgWebsite: z.string().url("Invalid URL").optional().or(z.literal("")),
    orgCountry: z.string().optional(),
    contactEmail: z.string().email("Invalid email"),
  });

  const projectStepSchema = z.object({
    projectName: z.string().min(3, "name must be between 3 and 120 characters").max(120, "name must be between 3 and 120 characters"),
    category: z.enum(PROJECT_CATEGORIES as [string, ...string[]]),
    description: z.string().min(10, "description must be between 10 and 5000 characters").max(5000, "description must be between 10 and 5000 characters"),
    location: z.string().min(2, "location must be between 2 and 200 characters").max(200, "location must be between 2 and 200 characters"),
    goalXLM: positiveNumberString,
  });

  const walletStepSchema = z.object({
    walletAddress: walletAddressSchema,
  });

  const methodologyStepSchema = z.object({
    co2MethodologyName: z.string().min(1, "Required"),
    co2VerificationBody: z.string().optional(),
    co2AnnualTonnes: positiveNumberString,
    co2DocumentUrl: z.string().url("Invalid URL").optional().or(z.literal("")),
    impactMetrics: z.array(z.string()).optional(),
  });

  const orgValidation = useFormValidation(orgStepSchema);
  const projectValidation = useFormValidation(projectStepSchema);
  const walletValidation = useFormValidation(walletStepSchema);
  const methodologyValidation = useFormValidation(methodologyStepSchema);

  const currentValidation =
    step === "org"
      ? orgValidation
      : step === "project"
        ? projectValidation
        : step === "wallet"
          ? walletValidation
          : step === "methodology"
            ? methodologyValidation
            : null;

  const fieldErrors = (currentValidation ? currentValidation.errors : {}) as Record<string, string | undefined>;

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
      walletValidation.clearField(field as any);
      methodologyValidation.clearField(field as any);
    };

  const toggleImpactMetric = (value: string) => {
    const current = impactMetrics ?? [];
    const updated = current.includes(value)
      ? current.filter((m) => m !== value)
      : [...current, value];
    setValue("impactMetrics", updated);
  };

  function validateStep(): boolean {
    if (step === "org") {
      return orgValidation.validate({
        orgName: form.orgName,
        orgWebsite: form.orgWebsite,
        orgCountry: form.orgCountry,
        contactEmail: form.contactEmail,
      });
    }
    if (step === "project") {
      return projectValidation.validate({
        projectName: form.projectName,
        category: form.category,
        description: form.description,
        location: form.location,
        goalXLM: form.goalXLM,
      });
    }
    if (step === "wallet") {
      return walletValidation.validate({
        walletAddress: form.walletAddress,
      });
    }
    if (step === "methodology") {
      return methodologyValidation.validate({
        co2MethodologyName: form.co2MethodologyName,
        co2VerificationBody: form.co2VerificationBody,
        co2AnnualTonnes: form.co2AnnualTonnes,
        co2DocumentUrl: form.co2DocumentUrl,
        impactMetrics: form.impactMetrics,
      });
    }
    return true;
  }

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

      <div className="card p-6 space-y-5">
        {/* Step: org */}
        {step === "org" && (
          <>
            <h2 className="font-display text-xl font-bold text-forest-900">
              Organization Info
            </h2>
            <FormField name="orgName" label="Organization Name *" error={fieldErrors.orgName}>
              <input
                className="input-field"
                value={form.orgName}
                onChange={set("orgName")}
                placeholder="Acme Climate Foundation"
                {...register("organization.name")}
              />
            </FormField>
            <FormField name="orgWebsite" label="Website" error={fieldErrors.orgWebsite}>
              <input
                className="input-field"
                value={form.orgWebsite}
                onChange={set("orgWebsite")}
                placeholder="https://acme.org"
                {...register("organization.website")}
              />
            </FormField>
            <FormField name="orgCountry" label="Country" error={fieldErrors.orgCountry}>
              <input
                className="input-field"
                value={form.orgCountry}
                onChange={set("orgCountry")}
                placeholder="Kenya"
                {...register("organization.country")}
              />
            </FormField>
            <FormField name="contactEmail" label="Contact Email *" error={fieldErrors.contactEmail}>
              <input
                className="input-field"
                type="email"
                error={getFieldError("organization", "contactEmail")}
                placeholder="hello@acme.org"
                {...register("organization.contactEmail")}
              />
            </FormField>
          </>
        )}

        {/* Step: project */}
        {step === "project" && (
          <>
            <h2 className="font-display text-xl font-bold text-forest-900">
              Project Details
            </h2>
            <FormField name="projectName" label="Project Name *" error={fieldErrors.projectName}>
              <input
                className="input-field"
                value={form.projectName}
                onChange={set("projectName")}
                placeholder="Acme Solar Farm Phase 1"
                {...register("name")}
              />
            </FormField>
            <FormField name="category" label="Category *" error={fieldErrors.category}>
              <select
                className="input-field"
                value={form.category}
                onChange={set("category")}
              >
                {PROJECT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField name="description" label="Description *" error={fieldErrors.description}>
              <textarea
                className="input-field min-h-[100px] resize-y"
                value={form.description}
                onChange={set("description")}
                placeholder="Describe the project's goals, impact, and methods…"
                {...register("description")}
              />
            </FormField>
            <FormField name="location" label="Location *" error={fieldErrors.location}>
              <input
                className="input-field"
                value={form.location}
                onChange={set("location")}
                placeholder="Nairobi, Kenya"
                {...register("location")}
              />
            </FormField>
            <FormField name="goalXLM" label="Funding Goal (XLM) *" error={fieldErrors.goalXLM}>
              <input
                className="input-field"
                type="number"
                min="1"
                step="any"
                error={errors.goalXLM?.message}
                placeholder="50000"
                {...register("goalXLM")}
              />
            </FormField>
          </>
        )}

        {/* Step: wallet */}
        {step === "wallet" && (
          <>
            <h2 className="font-display text-xl font-bold text-forest-900">
              Stellar Wallet
            </h2>
            <p className="text-sm text-[#5a7a5a] dark:text-[#8aaa8a] font-body">
              Donations will be sent directly to this Stellar address. Make sure
              you control it.
            </p>
            <FormField
              name="walletAddress"
              label="Stellar Wallet Address *"
              error={fieldErrors.walletAddress}
            >
              <input
                className="input-field font-mono text-sm"
                value={form.walletAddress}
                onChange={set("walletAddress")}
                placeholder="GABC…"
                spellCheck={false}
                {...register("walletAddress")}
              />
            </FormField>
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
              name="co2MethodologyName"
              label="Methodology Name *"
              error={fieldErrors.co2MethodologyName}
            >
              <input
                className="input-field"
                value={form.co2MethodologyName}
                onChange={set("co2MethodologyName")}
                placeholder="Verra VM0007"
                {...register("co2Methodology.name")}
              />
            </FormField>
            <FormField
              name="co2VerificationBody"
              label="Verification Body"
              error={fieldErrors.co2VerificationBody}
            >
              <input
                className="input-field"
                value={form.co2VerificationBody}
                onChange={set("co2VerificationBody")}
                placeholder="Gold Standard, Verra, etc."
                {...register("co2Methodology.verificationBody")}
              />
            </FormField>
            <FormField
              name="co2AnnualTonnes"
              label="Annual CO₂ Reduction (tonnes) *"
              error={fieldErrors.co2AnnualTonnes}
            >
              <input
                className="input-field"
                type="number"
                min="1"
                step="any"
                error={getFieldError("co2Methodology", "annualTonnesCO2")}
                placeholder="1200"
                {...register("co2Methodology.annualTonnesCO2")}
              />
            </FormField>
            <FormField
              name="co2DocumentUrl"
              label="Supporting Document URL"
              error={fieldErrors.co2DocumentUrl}
            >
              <input
                className="input-field"
                value={form.co2DocumentUrl}
                onChange={set("co2DocumentUrl")}
                placeholder="https://…"
                {...register("co2Methodology.documentUrl")}
              />
            </FormField>

            <FormField name="impactMetrics" label="Impact Metrics">
              <div className="flex flex-col gap-2 rounded-xl border border-[rgba(34,114,57,0.12)] bg-[#f8fcf8] p-3">
                {IMPACT_METRICS.map((metric) => (
                  <label
                    key={metric.value}
                    className="flex items-center gap-2 text-sm text-[#5a7a5a]"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-[#8aaa8a] text-emerald-600 focus:ring-emerald-500"
                      checked={form.impactMetrics.includes(metric.value)}
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
