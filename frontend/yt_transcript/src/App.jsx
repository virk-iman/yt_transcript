import React, { useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';

function formatTime(ms) {
  if (ms === undefined || ms === null) return '00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [transcriptData, setTranscriptData] = useState(null);
  const [summaryData, setSummaryData] = useState('');
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('transcript');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const resultsRef = useRef(null);

  const fetchTranscript = async () => {
    if (!url.trim()) return;
    setLoading(true);
    setError(null);
    setTranscriptData(null);
    try {
      const res = await fetch('http://localhost:5001/api/transcript', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      console.log('Received data:', data);
      if (!res.ok) {
        throw new Error(data.details || data.error || 'Failed to fetch transcript');
      }
      setTranscriptData(data);
      setSummaryData('');
      setActiveTab('transcript');
      // Auto-scroll to results after a short delay
      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchSummary = async () => {
    if (!transcriptData?.content || summaryData) return;
    setLoadingSummary(true);
    try {
      const res = await fetch('http://localhost:5001/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: transcriptData.content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate summary');
      setSummaryData(data.summary);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingSummary(false);
    }
  };



  const handleCopy = () => {
    if (!transcriptData?.content) return;
    const text = transcriptData.content.map(c => `[${formatTime(c.offset)}] ${c.text}`).join('\n');
    navigator.clipboard.writeText(text);
  };

  const handleDownload = () => {
    if (!transcriptData?.content) return;
    const text = transcriptData.content.map(c => `[${formatTime(c.offset)}] ${c.text}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'transcript.txt';
    a.click();
  };

  // Extract YouTube video ID for thumbnail
  const getVideoId = (videoUrl) => {
    try {
      const u = new URL(videoUrl);
      return u.searchParams.get('v') || u.pathname.split('/').pop();
    } catch { return null; }
  };
  const videoId = getVideoId(url);

  return (
    <div className="antialiased">
      {/* TopNavBar */}
      <header className="bg-white/80 backdrop-blur-md shadow-sm top-0 sticky z-50 transition-all duration-200">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between font-headline antialiased tracking-tight">
          <div className="text-2xl font-bold tracking-tighter text-slate-900">StreamFlow</div>
          <nav className="hidden md:flex items-center gap-8">
            <a className="text-blue-700 font-semibold border-b-2 border-blue-700 pb-1" href="#">Features</a>
            <a className="text-slate-600 hover:text-blue-600 transition-colors" href="#">Pricing</a>
            <a className="text-slate-600 hover:text-blue-600 transition-colors" href="#">Resources</a>
            <a className="text-slate-600 hover:text-blue-600 transition-colors" href="#">Company</a>
          </nav>
          <div className="flex items-center gap-4">
            <button className="px-5 py-2 text-slate-600 font-medium hover:bg-slate-50 rounded-lg transition-all duration-200">Login</button>
            <button className="px-6 py-2.5 bg-blue-700 text-white font-semibold rounded-lg shadow-sm hover:shadow-md transition-all">Get Started</button>
          </div>
        </div>
        <div className="h-[1px] w-full bg-gradient-to-b from-slate-100/50 to-transparent"></div>
      </header>

      <main className="relative overflow-hidden">
        {/* Hero Section */}
        <section className="pt-24 pb-16 px-6 max-w-5xl mx-auto text-center">
          <div className="mb-4 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-secondary-container text-primary font-medium text-sm">
            <span className="material-symbols-outlined text-sm">auto_awesome</span>
            <span>New: AI Summary Pro is now live</span>
          </div>
          <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight text-on-surface mb-6 font-headline">
            YouTube Transcript Generator
          </h1>
          <p className="text-xl text-on-surface-variant mb-12 max-w-2xl mx-auto">
            Instantly transcribe YouTube videos for free. Use AI to summarize, translate, and unlock insights from any video in seconds.
          </p>

          {/* URL Input Area */}
          <div className="max-w-3xl mx-auto mb-16">
            <div className="relative group">
              <div className="flex items-center p-2 rounded-xl bg-surface-container-highest shadow-sm group-focus-within:bg-surface-container-lowest group-focus-within:ring-2 group-focus-within:ring-primary/20 transition-all duration-300">
                <div className="pl-4 pr-3 flex items-center text-error">
                  <span className="material-symbols-outlined">smart_display</span>
                </div>
                <input
                  className="w-full bg-transparent border-none outline-none focus:ring-0 text-lg py-4 placeholder:text-outline"
                  placeholder="Paste YouTube video URL here..."
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && fetchTranscript()}
                />
                <button
                  onClick={fetchTranscript}
                  disabled={loading || !url.trim()}
                  className="bg-primary hover:bg-primary-dim text-white font-bold py-4 px-8 rounded-lg shadow-lg flex items-center gap-2 transition-transform active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  {loading ? (
                    <>
                      <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                      Loading...
                    </>
                  ) : (
                    'Get Transcript'
                  )}
                </button>
              </div>
            </div>
            <p className="mt-4 text-sm text-on-surface-variant flex justify-center items-center gap-4">
              <span>No registration required</span>
              <span className="w-1 h-1 bg-outline rounded-full"></span>
              <span>100% Free</span>
              <span className="w-1 h-1 bg-outline rounded-full"></span>
              <span>AI Powered</span>
            </p>
          </div>
        </section>

        {/* Features Bento Grid - show when no transcript loaded */}
        {!transcriptData && !loading && (
          <section className="max-w-7xl mx-auto px-6 mb-24">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="p-8 rounded-2xl bg-surface-container-lowest shadow-sm border border-outline-variant/15 hover:bg-primary-container/10 transition-all duration-300">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary mb-6">
                  <span className="material-symbols-outlined">transcribe</span>
                </div>
                <h3 className="text-xl font-bold mb-3 font-headline">AI Transcription</h3>
                <p className="text-on-surface-variant leading-relaxed">High-precision word-for-word transcriptions powered by neural speech recognition.</p>
              </div>
              <div className="p-8 rounded-2xl bg-surface-container-lowest shadow-sm border border-outline-variant/15 hover:bg-primary-container/10 transition-all duration-300 mt-0 md:mt-4">
                <div className="w-12 h-12 rounded-xl bg-tertiary/10 flex items-center justify-center text-tertiary mb-6">
                  <span className="material-symbols-outlined">closed_caption</span>
                </div>
                <h3 className="text-xl font-bold mb-3 font-headline">Auto Subtitles</h3>
                <p className="text-on-surface-variant leading-relaxed">Export perfectly timed subtitles in .SRT or .VTT formats for your video projects.</p>
              </div>
              <div className="p-8 rounded-2xl bg-surface-container-lowest shadow-sm border border-outline-variant/15 hover:bg-primary-container/10 transition-all duration-300 mt-0 md:mt-8">
                <div className="w-12 h-12 rounded-xl bg-primary-container/20 flex items-center justify-center text-primary-dim mb-6">
                  <span className="material-symbols-outlined">summarize</span>
                </div>
                <h3 className="text-xl font-bold mb-3 font-headline">AI Summaries</h3>
                <p className="text-on-surface-variant leading-relaxed">Turn hour-long videos into concise bullet points and actionable insights instantly.</p>
              </div>
            </div>
          </section>
        )}

        {/* Error Message */}
        {error && (
          <section className="max-w-3xl mx-auto px-6 mb-12">
            <div className="bg-error-container/10 border border-error/20 rounded-2xl p-6 text-center">
              <span className="material-symbols-outlined text-error text-3xl mb-2">error</span>
              <p className="text-error font-medium">{error}</p>
            </div>
          </section>
        )}

        {/* Loading State */}
        {loading && (
          <section className="max-w-3xl mx-auto px-6 mb-12">
            <div className="bg-surface-container rounded-3xl p-12 text-center shadow-xl animate-pulse">
              <span className="material-symbols-outlined text-primary text-5xl mb-4 animate-spin">progress_activity</span>
              <p className="text-on-surface-variant text-lg">Fetching transcript...</p>
              <p className="text-on-surface-variant text-sm mt-2">This may take a few seconds</p>
            </div>
          </section>
        )}

        {/* Transcript Results */}
        {transcriptData && transcriptData.content && (
          <section ref={resultsRef} className="max-w-7xl mx-auto px-6 mb-32">
            <div className="bg-surface-container rounded-3xl overflow-hidden shadow-xl">
              <div className="p-8 md:p-12 grid grid-cols-1 lg:grid-cols-12 gap-12">

                {/* Video Preview Area */}
                <div className="lg:col-span-5 space-y-6">
                  <div className="aspect-video rounded-2xl overflow-hidden bg-on-surface relative shadow-lg group">
                    {videoId ? (
                      <img className="w-full h-full object-cover" alt="Video thumbnail" src={`https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`} />
                    ) : (
                      <div className="w-full h-full bg-slate-800 flex items-center justify-center">
                        <span className="material-symbols-outlined text-5xl text-white/40">smart_display</span>
                      </div>
                    )}
                    {videoId && (
                      <a href={url} target="_blank" rel="noreferrer" className="absolute inset-0 flex items-center justify-center">
                        <button className="w-20 h-20 bg-white/20 backdrop-blur-md rounded-full flex items-center justify-center text-white transition-transform hover:scale-110 active:scale-95">
                          <span className="material-symbols-outlined text-5xl" style={{ fontVariationSettings: '"FILL" 1' }}>play_arrow</span>
                        </button>
                      </a>
                    )}
                  </div>
                  <div className="p-6 bg-surface-container-lowest rounded-2xl">
                    <h4 className="font-bold text-lg mb-2 font-headline">{transcriptData.title || 'Video Transcript'}</h4>
                    <p className="text-on-surface-variant text-sm flex items-center gap-2">
                      <span className="material-symbols-outlined text-sm">schedule</span>
                      {transcriptData.content.length} segments
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <button onClick={handleCopy} className="flex-1 px-4 py-3 bg-primary text-white rounded-xl font-semibold flex items-center justify-center gap-2 shadow-sm hover:shadow-md active:scale-95 transition-all">
                      <span className="material-symbols-outlined text-sm">content_copy</span> Copy
                    </button>
                    <button onClick={handleDownload} className="flex-1 px-4 py-3 bg-surface-container-highest text-on-surface rounded-xl font-semibold flex items-center justify-center gap-2 shadow-sm hover:shadow-md active:scale-95 transition-all">
                      <span className="material-symbols-outlined text-sm">download</span> Download .txt
                    </button>
                  </div>
                </div>

                {/* Transcript Area */}
                <div className="lg:col-span-7 flex flex-col h-[600px]">
                  <div className="flex items-center p-1 bg-surface-container-high rounded-xl mb-6 self-start">
                    <button
                      onClick={() => setActiveTab('transcript')}
                      className={`px-6 py-2 rounded-lg font-bold transition-all shadow-sm ${activeTab === 'transcript' ? 'bg-surface-container-lowest text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
                    >
                      Transcript
                    </button>
                    <button
                      onClick={() => {
                        setActiveTab('summary');
                        fetchSummary();
                      }}
                      className={`px-6 py-2 rounded-lg font-bold transition-all ${activeTab === 'summary' ? 'bg-surface-container-lowest text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
                    >
                      Summary
                    </button>
                  </div>
                  <div className="flex-1 bg-surface-container-lowest rounded-2xl overflow-hidden flex flex-col shadow-sm">
                    <div className="p-4 border-b border-outline-variant/10 flex justify-between items-center bg-surface-container-low/30">
                      <span className="text-sm font-medium text-on-surface-variant">
                        {activeTab === 'transcript' ? (transcriptData.lang ? `${transcriptData.lang.toUpperCase()} (Auto-generated)` : 'English (Auto-generated)') : 'Groq AI Summary'}
                      </span>
                      {activeTab === 'summary' && summaryData && (
                        <button
                          onClick={() => setIsFullscreen(true)}
                          className="flex items-center gap-1.5 px-3 py-1 bg-surface-container-highest/50 hover:bg-surface-container-highest rounded-lg transition-all text-xs font-bold text-primary group"
                        >
                          <span className="material-symbols-outlined text-sm transition-transform group-hover:scale-110">fullscreen</span>
                          Fullscreen
                        </button>
                      )}
                    </div>
                    <div className="flex-1 overflow-y-auto p-6 scroll-smooth">
                      {activeTab === 'transcript' ? (
                        <div className="space-y-4">
                          {transcriptData.content.map((item, idx) => (
                            <div key={idx} className={`flex gap-6 group ${idx % 2 === 1 ? 'bg-surface-container-low/40 p-4 rounded-xl' : ''}`}>
                              <span className="text-primary font-mono text-xs pt-1 opacity-60 group-hover:opacity-100 whitespace-nowrap">
                                {formatTime(item.offset)}
                              </span>
                              <div className="space-y-1">
                                <p className="text-on-surface leading-relaxed">{item.text}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="prose prose-sm max-w-none text-on-surface">
                          {loadingSummary ? (
                            <div className="space-y-4 animate-pulse">
                              <div className="h-4 bg-surface-container-high rounded w-3/4"></div>
                              <div className="h-4 bg-surface-container-high rounded w-full"></div>
                              <div className="h-4 bg-surface-container-high rounded w-5/6"></div>
                              <div className="mt-8 space-y-2">
                                <div className="h-4 bg-surface-container-high rounded w-1/4"></div>
                                <div className="h-4 bg-surface-container-high rounded w-full"></div>
                                <div className="h-4 bg-surface-container-high rounded w-full"></div>
                              </div>
                            </div>
                          ) : (
                            <div className="prose-markdown leading-relaxed">
                              {summaryData ? (
                                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
                                  {summaryData}
                                </ReactMarkdown>
                              ) : "Waiting to generate summary..."}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="p-6 bg-surface-container-low/30 border-t border-outline-variant/10 flex justify-between items-center">
                      <div className="flex items-center gap-4">
                        <div className="flex -space-x-2">
                          <div className="w-8 h-8 rounded-full bg-blue-100 border-2 border-white flex items-center justify-center text-[10px] font-bold text-primary">AI</div>
                          <div className="w-8 h-8 rounded-full bg-green-100 border-2 border-white flex items-center justify-center text-[10px] font-bold text-tertiary">
                            {transcriptData.content.length}
                          </div>
                        </div>
                        <span className="text-xs text-on-surface-variant font-medium">
                          {transcriptData.content.length} segments transcribed
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

              </div>
            </div>
          </section>
        )}
      </main>

      {/* Footer */}
      <footer className="bg-slate-50 border-t border-slate-200">
        <div className="max-w-7xl mx-auto px-8 py-12 flex flex-col md:flex-row justify-between items-center gap-6 font-body text-sm">
          <div className="flex flex-col items-center md:items-start gap-2">
            <span className="font-headline font-bold text-slate-900 text-xl tracking-tight">StreamFlow</span>
            <p className="text-slate-500">© 2024 StreamFlow AI. All rights reserved.</p>
          </div>
          <div className="flex flex-wrap justify-center gap-8">
            <a className="text-slate-500 hover:text-slate-900 underline decoration-blue-500 underline-offset-4 transition-all duration-200" href="#">Privacy Policy</a>
            <a className="text-slate-500 hover:text-slate-900 underline decoration-blue-500 underline-offset-4 transition-all duration-200" href="#">Terms of Service</a>
            <a className="text-slate-500 hover:text-slate-900 underline decoration-blue-500 underline-offset-4 transition-all duration-200" href="#">Security</a>
            <a className="text-slate-500 hover:text-slate-900 underline decoration-blue-500 underline-offset-4 transition-all duration-200" href="#">Status</a>
          </div>
          <div className="flex gap-4">
            <a className="w-10 h-10 rounded-full flex items-center justify-center text-slate-400 hover:text-primary hover:bg-white transition-all opacity-80 hover:opacity-100" href="#">
              <span className="material-symbols-outlined">share</span>
            </a>
            <a className="w-10 h-10 rounded-full flex items-center justify-center text-slate-400 hover:text-primary hover:bg-white transition-all opacity-80 hover:opacity-100" href="#">
              <span className="material-symbols-outlined">language</span>
            </a>
          </div>
        </div>
      </footer>

      {/* Fullscreen Summary Overlay */}
      {isFullscreen && (
        <div className="fixed inset-0 z-[100] bg-white flex flex-col p-6 md:p-12 overflow-hidden animate-in fade-in duration-300">
          <div className="max-w-5xl mx-auto w-full flex flex-col h-full">
            <div className="flex justify-between items-center mb-8 pb-6 border-b border-slate-100">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                  <span className="material-symbols-outlined">summarize</span>
                </div>
                <div>
                  <h2 className="text-2xl font-bold font-headline text-slate-900">AI Detailed Summary</h2>
                  <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">Powered by Groq AI</p>
                </div>
              </div>
              <button
                onClick={() => setIsFullscreen(false)}
                className="w-12 h-12 flex items-center justify-center bg-slate-50 hover:bg-slate-100 text-slate-600 rounded-full transition-all hover:rotate-90"
              >
                <span className="material-symbols-outlined text-3xl">close</span>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto pr-4 scroll-smooth custom-scrollbar">
              <div className="prose-markdown leading-relaxed pb-32">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
                  {summaryData}
                </ReactMarkdown>
              </div>
            </div>
            <div className="absolute bottom-12 left-1/2 -translate-x-1/2">
              <button
                onClick={() => setIsFullscreen(false)}
                className="px-8 py-3 bg-slate-900 text-white rounded-full font-bold shadow-xl hover:shadow-2xl hover:-translate-y-1 transition-all flex items-center gap-2"
              >
                <span className="material-symbols-outlined text-sm">close_fullscreen</span>
                Exit Fullscreen
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
