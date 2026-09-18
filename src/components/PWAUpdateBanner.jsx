import { useRegisterSW } from 'virtual:pwa-register/react';

export default function PWAUpdateBanner() {
  const {
    needRefresh:   [needRefresh,   setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div style={s.banner}>
      <span style={s.msg}>A new version of oodbo is available</span>
      <button style={s.btn} onClick={() => updateServiceWorker(true)}>reload</button>
      <button style={s.dismiss} onClick={() => setNeedRefresh(false)}>later</button>
    </div>
  );
}

const s = {
  banner: {
    position:   'fixed',
    top:        0,
    left:       0,
    right:      0,
    zIndex:     9999,
    background: '#f5f2eb',
    borderBottom: '1px solid #ddd6c9',
    padding:    '10px 20px',
    display:    'flex',
    alignItems: 'center',
    gap:        12,
    fontFamily: 'Georgia, serif',
    fontSize:   13,
  },
  msg: {
    flex:      1,
    color:     '#555',
    fontStyle: 'italic',
  },
  btn: {
    fontFamily: 'Georgia, serif',
    fontStyle:  'italic',
    fontSize:   13,
    background: '#111',
    color:      '#f5f2eb',
    border:     'none',
    borderRadius: 3,
    padding:    '4px 14px',
    cursor:     'pointer',
  },
  dismiss: {
    fontFamily: 'Georgia, serif',
    fontStyle:  'italic',
    fontSize:   13,
    background: 'none',
    color:      '#999',
    border:     'none',
    padding:    '4px 4px',
    cursor:     'pointer',
  },
};
