import { useState } from "react";

export default function TestTTS() {
  const [text, setText] = useState("Hello, this is a test of the puter.js text-to-speech functionality.");
  const [isLoading, setIsLoading] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);


  const generateTTS = async () => {
    setIsLoading(true);
    setError(null);
    setAudioUrl(null);

    try {
      // Generate TTS using puter.js (client-side only)
      if (typeof window !== 'undefined' && (window as any).puter) {
        console.log('Generating TTS with puter.js...');
        (window as any).puter.ai.txt2speech("test");
        const audioElement = await (window as any).puter.ai.txt2speech(text);
        console.log('Audio generated:', audioElement);

        // Set the audio URL for playback
        setAudioUrl(audioElement.src);
        
      } else {
        throw new Error('Puter.js not loaded. Please ensure the script is included.');
      }
      
    } catch (err) {
      console.error('TTS Generation Error:', err);
      setError(err instanceof Error ? err.message : 'Unknown error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Text-to-Speech Test Page</h1>
      
      <div className="mb-6">
        <label htmlFor="text" className="block text-sm font-medium mb-2">
          Text to convert to speech:
        </label>
        <textarea
          id="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-full h-32 p-3 border border-gray-300 rounded-md"
          placeholder="Enter text to convert to speech..."
        />
      </div>



      <div className="flex gap-4 mb-6">        
        <button
          onClick={generateTTS}
          disabled={isLoading}
          className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:bg-gray-400"
        >
          {isLoading ? 'Generating...' : 'Generate TTS'}
        </button>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-100 border border-red-400 text-red-700 rounded-md">
          <strong>Error:</strong> {error}
        </div>
      )}

      {audioUrl && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-2">Generated Audio:</h3>
          <audio controls className="w-full">
            <source src={audioUrl} type="audio/mpeg" />
            Your browser does not support the audio element.
          </audio>
          <button
            onClick={() => {
              const a = document.createElement('a');
              a.href = audioUrl;
              a.download = 'test-audio.mp3';
              a.click();
            }}
            className="mt-2 px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700"
          >
            Download Audio
          </button>
        </div>
      )}
    </div>
  );
} 