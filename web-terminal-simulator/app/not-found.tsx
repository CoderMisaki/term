import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white p-4">
      <h2 className="text-2xl font-bold mb-4">404 - Not Found</h2>
      <p className="mb-4">Could not find requested resource</p>
      <Link href="/" className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded">
        Return Home
      </Link>
    </div>
  );
}
