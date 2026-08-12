'use client';

import dynamic from 'next/dynamic';

const Terminal = dynamic(() => import('../components/Terminal'), {
  ssr: false,
  loading: () => <div className="w-full h-full min-h-screen flex items-center justify-center bg-black text-white">Loading Terminal...</div>
});

export default function Home() {
  return (
    <main className="flex-1 flex flex-col w-full h-full min-h-screen bg-black">
      <div className="flex-1 w-full h-full">
        <Terminal />
      </div>
    </main>
  );
}
