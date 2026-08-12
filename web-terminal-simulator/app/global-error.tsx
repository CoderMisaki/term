'use client';

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body>
        <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white p-4">
          <h2 className="text-2xl font-bold mb-4">Something went wrong globally!</h2>
          <button
            onClick={() => reset()}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
