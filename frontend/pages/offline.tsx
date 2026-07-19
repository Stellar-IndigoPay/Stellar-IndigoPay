import Link from "next/link";

export default function OfflinePage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#FAFAFE] px-6 py-16 dark:bg-[#0A0A1A]">
      <div className="max-w-md text-center">
        <div className="mb-4 text-2xl font-semibold" aria-hidden="true">
          Offline
        </div>
        <h1 className="mb-3 font-semibold text-3xl text-slate-900 dark:text-slate-100">
          You&apos;re offline
        </h1>
        <p className="mb-6 text-slate-600 dark:text-slate-400">
          It looks like you are not connected to the internet. Some features may be limited, but you can still browse previously viewed projects.
        </p>
        <Link
          href="/projects"
          className="inline-flex rounded-md bg-indigo-600 px-4 py-2 font-medium text-white"
        >
          Browse cached projects
        </Link>
      </div>
    </div>
  );
}
