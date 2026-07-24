import { useEffect, useState } from "react";

import * as api from "./api";
import { Me } from "./api";
import Loader from "./Loader";
import OwnerApp from "./OwnerApp";
import WorkspaceApp from "./WorkspaceApp";

function App() {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    api.getMe().then((m) => {
      if (!m) {
        window.location.reload();
        return;
      }
      setMe(m);
    });
  }, []);

  async function handleLogout() {
    await api.logout();
    window.location.reload();
  }

  if (!me) return <Loader />;

  // Root → hidden owner console; everyone else → their org's workspace app.
  return me.role === "root" ? (
    <OwnerApp me={me} onLogout={handleLogout} />
  ) : (
    <WorkspaceApp me={me} onLogout={handleLogout} />
  );
}

export default App;
