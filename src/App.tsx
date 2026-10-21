import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { Agentation } from "agentation";
import { Toaster } from "react-hot-toast";
import { ThemeProvider } from "@Contexts/ThemeProvider";
import { ThreadsProvider } from "@Contexts/ThreadsProvider";
import AgentPage from "@Pages/AgentPage";

const App = () => {
  const isElectron =
    typeof window !== "undefined" && window.location.protocol === "file:";

  // HashRouter: 정적 파일(file://)에서도 새로고침·직접 진입이 동작한다.
  return (
    <HashRouter>
      <ThemeProvider>
        <ThreadsProvider>
          <div className="flex flex-col h-screen bg-white">
            <main className="flex-1 min-h-0 flex flex-col bg-white">
              <Routes>
                <Route path="/agent" element={<AgentPage />} />
                <Route path="/agent/:threadId" element={<AgentPage />} />
                <Route path="*" element={<Navigate to="/agent" replace />} />
              </Routes>
            </main>
          </div>
        </ThreadsProvider>
        <Toaster position="top-right" />
      </ThemeProvider>
      {process.env.NODE_ENV === "development" && !isElectron && (
        <Agentation
          endpoint="http://localhost:4747"
          onSessionCreated={(sessionId) => {
            console.log("Session started:", sessionId);
          }}
        />
      )}
    </HashRouter>
  );
};

export default App;
