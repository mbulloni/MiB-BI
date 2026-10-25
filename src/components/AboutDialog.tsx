// Guida › Informazioni: application icon, name, version and credits.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { checkUpdates } from './Updates';
import { useStore } from '../store';
import { Icon } from './icons';
import logo from '../assets/logo-256.png';

export function AboutDialog() {
  const open = useStore((s) => s.aboutDialog);
  const set = useStore((s) => s.set);
  const [version, setVersion] = useState('');
  useEffect(() => { if (open) api.appVersion().then(setVersion).catch(() => {}); }, [open]);
  if (!open) return null;
  const close = () => set({ aboutDialog: false });
  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className="dialog about-dlg" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dh"><h2>Informazioni su MiB-BI</h2><button onClick={close}><Icon name="close" /></button></div>
        <div className="about-body">
          <img src={logo} width={112} height={112} alt="MiB-BI" draggable={false} />
          <div>
            <div className="about-name">MiB-BI</div>
            <div className="about-ver">Versione {version} · <button className="link" onClick={() => checkUpdates(false)}>Controlla aggiornamenti</button></div>
            <p>Clone educativo di Power BI Desktop per Linux. Non affiliato a Microsoft.</p>
            <p>Motore: DuckDB · Grafici: Apache ECharts · Interfaccia: Electron e React.</p>
            <p><a href="#" onClick={(e) => { e.preventDefault(); api.openExternal('https://github.com/mbulloni/MiB-BI'); }}>github.com/mbulloni/MiB-BI</a> · Licenza MIT</p>
          </div>
        </div>
        <div className="df"><button className="btn primary" onClick={close}>OK</button></div>
      </div>
    </div>
  );
}
