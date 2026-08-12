'use client';

import dynamic from 'next/dynamic';

const Terminal = dynamic(() => import('../components/Terminal'), {
  ssr: false,
  loading: () => <div className="w-full h-full min-h-[400px] flex items-center justify-center bg-black text-white rounded-lg">Loading Terminal...</div>
});

export default function Home() {
  return (
    <main className="flex-1 flex flex-col p-4 md:p-8 max-w-5xl mx-auto w-full">
      <h1 className="text-2xl font-bold mb-4">Web Terminal Simulator</h1>
      <div className="flex-1 border border-zinc-800 rounded-lg overflow-hidden shadow-2xl">
        <Terminal />
      </div>
    </main>
  );
}
