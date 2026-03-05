import { useState, useCallback, useRef, useEffect } from 'react';

// ─── API Helper ────────────────────────────────────────
const api = {
  async request(endpoint, options = {}) {
    const headers = { ...options.headers };
    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`/api/${endpoint}`, { ...options, headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
    return data;
  },

  async aiGenerate(type, inputData) {
    return this.request('ai-generate', {
      method: 'POST',
      body: JSON.stringify({ type, data: inputData }),
    });
  },

  async uploadImage(file, metadata = {}) {
    const form = new FormData();
    form.append('file', file);
    if (Object.keys(metadata).length) {
      form.append('metadata', JSON.stringify(metadata));
    }
    return this.request('upload-image', { method: 'POST', body: form });
  },

  async commitFiles(files, message) {
    return this.request('github-commit', {
      method: 'POST',
      body: JSON.stringify({ files, message }),
    });
  },

  async getContent(path) {
    return this.request(`github-commit?path=${encodeURIComponent(path)}`, { method: 'GET' });
  },
};


// ─── Styles ────────────────────────────────────────────
const C = {
  yellow: '#FFD500',
  yellowHover: '#E6C000',
  purple: '#7A00DF',
  purpleLight: '#F3E8FF',
  dark: '#2D2E33',
  darkDeep: '#1A1B1F',
  cream: '#FEFCF5',
  warmGray: '#F5F4F0',
  white: '#FFFFFF',
  border: '#E5E3DE',
  textMuted: '#6B6D74',
  red: '#DC2626',
  green: '#16A34A',
  greenBg: '#F0FDF4',
  redBg: '#FEF2F2',
};

const font = {
  display: "'Libre Baskerville', Georgia, serif",
  body: "'Outfit', -apple-system, sans-serif",
};

// Reusable style objects
const s = {
  card: {
    background: C.white,
    borderRadius: 12,
    border: `1px solid ${C.border}`,
    padding: 28,
    marginBottom: 20,
  },
  input: {
    width: '100%',
    padding: '10px 14px',
    borderRadius: 8,
    border: `1.5px solid ${C.border}`,
    fontFamily: font.body,
    fontSize: 14,
    color: C.dark,
    outline: 'none',
    transition: 'border-color 0.15s',
    background: C.white,
  },
  label: {
    display: 'block',
    fontSize: 13,
    fontWeight: 600,
    color: C.dark,
    marginBottom: 6,
    fontFamily: font.body,
  },
  btnPrimary: {
    padding: '10px 24px',
    background: C.yellow,
    color: C.dark,
    border: 'none',
    borderRadius: 8,
    fontFamily: font.body,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.15s',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
  },
  btnSecondary: {
    padding: '10px 24px',
    background: 'transparent',
    color: C.dark,
    border: `1.5px solid ${C.border}`,
    borderRadius: 8,
    fontFamily: font.body,
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.15s',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
  },
  btnDanger: {
    padding: '6px 14px',
    background: C.redBg,
    color: C.red,
    border: `1px solid #FECACA`,
    borderRadius: 6,
    fontFamily: font.body,
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
  },
  fieldGroup: {
    marginBottom: 20,
  },
  row: {
    display: 'flex',
    gap: 16,
    marginBottom: 20,
  },
  tag: {
    display: 'inline-block',
    padding: '3px 10px',
    background: C.purpleLight,
    color: C.purple,
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
    fontFamily: font.body,
  },
};


// ─── Shared UI Components ──────────────────────────────

function Field({ label, children, hint, required }) {
  return (
    <div style={s.fieldGroup}>
      <label style={s.label}>
        {label} {required && <span style={{ color: C.red }}>*</span>}
      </label>
      {children}
      {hint && <p style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>{hint}</p>}
    </div>
  );
}

function Input({ ...props }) {
  return <input style={s.input} {...props} />;
}

function Textarea({ rows = 4, ...props }) {
  return <textarea style={{ ...s.input, resize: 'vertical', minHeight: rows * 24 }} rows={rows} {...props} />;
}

function Select({ options, placeholder, ...props }) {
  return (
    <select style={{ ...s.input, cursor: 'pointer' }} {...props}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map(o => (
        <option key={typeof o === 'string' ? o : o.value} value={typeof o === 'string' ? o : o.value}>
          {typeof o === 'string' ? o : o.label}
        </option>
      ))}
    </select>
  );
}

function StatusBanner({ type, message, onDismiss }) {
  if (!message) return null;
  const isError = type === 'error';
  return (
    <div style={{
      padding: '12px 16px',
      borderRadius: 8,
      background: isError ? C.redBg : C.greenBg,
      border: `1px solid ${isError ? '#FECACA' : '#BBF7D0'}`,
      color: isError ? C.red : C.green,
      fontSize: 14,
      fontFamily: font.body,
      marginBottom: 20,
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
    }}>
      <span>{isError ? '⚠ ' : '✓ '}{message}</span>
      {onDismiss && (
        <button onClick={onDismiss} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'inherit', fontSize: 18, lineHeight: 1,
        }}>×</button>
      )}
    </div>
  );
}

function Spinner({ size = 16 }) {
  return (
    <span style={{
      display: 'inline-block',
      width: size,
      height: size,
      border: `2px solid ${C.border}`,
      borderTopColor: C.yellow,
      borderRadius: '50%',
      animation: 'admin-spin 0.6s linear infinite',
    }} />
  );
}

function ImageDropZone({ files, setFiles, label = 'Drop photos here or click to browse', multiple = true }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = useCallback((newFiles) => {
    const imageFiles = Array.from(newFiles).filter(f => f.type.startsWith('image/'));
    setFiles(prev => [...prev, ...imageFiles.map(f => ({
      file: f,
      preview: URL.createObjectURL(f),
      status: 'pending',
      cfId: null,
    }))]);
  }, [setFiles]);

  return (
    <div>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        style={{
          border: `2px dashed ${dragOver ? C.yellow : C.border}`,
          borderRadius: 12,
          padding: '32px 20px',
          textAlign: 'center',
          cursor: 'pointer',
          background: dragOver ? '#FFFEF5' : C.warmGray,
          transition: 'all 0.15s',
        }}
      >
        <div style={{ fontSize: 32, marginBottom: 8 }}>📸</div>
        <p style={{ fontSize: 14, color: C.textMuted, margin: 0 }}>{label}</p>
        <p style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>PNG, JPG, or WebP</p>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple={multiple}
          onChange={(e) => handleFiles(e.target.files)}
          style={{ display: 'none' }}
        />
      </div>

      {files.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 16 }}>
          {files.map((f, i) => (
            <div key={i} style={{
              position: 'relative',
              width: 100,
              height: 100,
              borderRadius: 8,
              overflow: 'hidden',
              border: `2px solid ${f.status === 'uploaded' ? C.green : f.status === 'error' ? C.red : C.border}`,
            }}>
              <img src={f.preview} alt="" style={{
                width: '100%', height: '100%', objectFit: 'cover',
              }} />
              {f.status === 'uploading' && (
                <div style={{
                  position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Spinner size={20} />
                </div>
              )}
              {f.status === 'uploaded' && (
                <div style={{
                  position: 'absolute', top: 4, right: 4,
                  background: C.green, color: C.white, borderRadius: '50%',
                  width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12,
                }}>✓</div>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  URL.revokeObjectURL(f.preview);
                  setFiles(prev => prev.filter((_, idx) => idx !== i));
                }}
                style={{
                  position: 'absolute', top: 4, left: 4,
                  background: 'rgba(0,0,0,0.6)', color: C.white, border: 'none',
                  borderRadius: '50%', width: 20, height: 20, cursor: 'pointer',
                  fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ─── Auth Gate ──────────────────────────────────────────



// ─── Dashboard ─────────────────────────────────────────

function Dashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadStats() {
      try {
        const [kids, rooms, partners] = await Promise.all([
          api.getContent('src/content/kids').catch(() => ({ files: [] })),
          api.getContent('src/content/rooms').catch(() => ({ files: [] })),
          api.getContent('src/content/partners').catch(() => ({ files: [] })),
        ]);
        setStats({
          kids: kids.files?.length || 0,
          rooms: rooms.files?.length || 0,
          partners: partners.files?.length || 0,
        });
      } catch {
        setStats({ kids: 0, rooms: 0, partners: 0 });
      } finally {
        setLoading(false);
      }
    }
    loadStats();
  }, []);

  const statCards = [
    { label: 'Kids', count: stats?.kids || 0, icon: '👧🏽', color: C.yellow },
    { label: 'Rooms', count: stats?.rooms || 0, icon: '🏠', color: C.purple },
    { label: 'Partners', count: stats?.partners || 0, icon: '🤝', color: '#2563EB' },
  ];

  return (
    <div>
      <h2 style={{ fontFamily: font.display, fontSize: 24, marginBottom: 8 }}>Dashboard</h2>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 32 }}>
        Content overview for sunshineonaranneyday.com
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 32 }}>
        {statCards.map(c => (
          <div key={c.label} style={{
            ...s.card,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            marginBottom: 0,
          }}>
            <div style={{
              width: 48, height: 48, borderRadius: 12,
              background: `${c.color}18`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 24,
            }}>{c.icon}</div>
            <div>
              <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1 }}>
                {loading ? '—' : c.count}
              </div>
              <div style={{ fontSize: 13, color: C.textMuted }}>{c.label}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={s.card}>
        <h3 style={{ fontFamily: font.display, fontSize: 18, marginBottom: 12 }}>Quick Start</h3>
        <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.7 }}>
          <p><strong>1.</strong> Use the sidebar to add kids, rooms, partners, or financial docs.</p>
          <p style={{ marginTop: 8 }}><strong>2.</strong> Fill in the form and upload photos — they go straight to Cloudflare Images.</p>
          <p style={{ marginTop: 8 }}><strong>3.</strong> For kids and rooms, click <strong>"Generate with AI"</strong> to create bios, descriptions, and SEO meta.</p>
          <p style={{ marginTop: 8 }}><strong>4.</strong> Hit <strong>"Publish"</strong> — content is committed to GitHub and the site rebuilds in ~15 seconds.</p>
        </div>
      </div>

      <div style={s.card}>
        <h3 style={{ fontFamily: font.display, fontSize: 18, marginBottom: 12 }}>Environment Status</h3>
        <EnvCheck />
      </div>
    </div>
  );
}

function EnvCheck() {
  const [status, setStatus] = useState({});
  const [checked, setChecked] = useState(false);

  const checkEnv = async () => {
    setChecked(true);
    const results = {};

    // Check AI
    try {
      await api.request('ai-generate', {
        method: 'POST',
        body: JSON.stringify({ type: 'test', data: {} }),
      });
      results.ai = 'ok';
    } catch (e) {
      results.ai = e.message.includes('Unknown generation type') ? 'ok' : e.message;
    }

    // Check image upload endpoint
    try {
      const form = new FormData();
      form.append('test', 'true');
      await api.request('upload-image', { method: 'POST', body: form });
      results.images = 'ok';
    } catch (e) {
      results.images = e.message.includes('No file') ? 'ok' : e.message;
    }

    // Check GitHub
    try {
      await api.getContent('README.md');
      results.github = 'ok';
    } catch (e) {
      results.github = e.message;
    }

    setStatus(results);
  };

  if (!checked) {
    return (
      <button onClick={checkEnv} style={s.btnSecondary}>
        Check API Connections
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {[
        { key: 'ai', label: 'Anthropic API (AI generation)' },
        { key: 'images', label: 'Cloudflare Images (photo uploads)' },
        { key: 'github', label: 'GitHub API (content publishing)' },
      ].map(({ key, label }) => (
        <div key={key} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 12px', borderRadius: 6,
          background: status[key] === 'ok' ? C.greenBg : status[key] ? C.redBg : C.warmGray,
          fontSize: 13,
        }}>
          <span>{status[key] === 'ok' ? '✅' : status[key] ? '❌' : '⏳'}</span>
          <span style={{ fontWeight: 500 }}>{label}</span>
          {status[key] && status[key] !== 'ok' && (
            <span style={{ color: C.red, fontSize: 12, marginLeft: 'auto' }}>{status[key]}</span>
          )}
        </div>
      ))}
    </div>
  );
}


// ─── Add Kid ───────────────────────────────────────────

const ROOM_TYPES = [
  { value: 'bedroom', label: 'Dream Bedroom' },
  { value: 'bathroom', label: 'Accessible Bathroom' },
  { value: 'therapy', label: 'Therapy Room' },
  { value: 'playroom', label: 'Playroom' },
  { value: 'sensory', label: 'Sensory Room' },
  { value: 'other', label: 'Other' },
];

function AddKid() {
  const [form, setForm] = useState({
    name: '', age: '', diagnosis: '', roomType: '', notes: '',
  });
  const [photos, setPhotos] = useState([]);
  const [generated, setGenerated] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [status, setStatus] = useState({ type: '', message: '' });

  const update = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }));

  const slug = form.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const generateContent = async () => {
    if (!form.name || !form.age || !form.diagnosis) {
      setStatus({ type: 'error', message: 'Please fill in name, age, and diagnosis before generating.' });
      return;
    }
    setAiLoading(true);
    setStatus({ type: '', message: '' });
    try {
      // Generate bio
      const bioResult = await api.aiGenerate('kid-bio', form);
      let result = bioResult.generated;

      // Generate alt texts if we have photos
      if (photos.length > 0) {
        const altResult = await api.aiGenerate('kid-alt-text', {
          name: form.name,
          age: form.age,
          photoCount: photos.length,
          context: `${form.roomType} makeover`,
          filenames: photos.map(p => p.file.name),
        });
        result.altTexts = altResult.generated.altTexts;
      }

      setGenerated(result);
      setStatus({ type: 'success', message: 'AI content generated! Review and edit below, then publish.' });
    } catch (err) {
      setStatus({ type: 'error', message: `AI generation failed: ${err.message}` });
    } finally {
      setAiLoading(false);
    }
  };

  const publish = async () => {
    if (!form.name || !generated) {
      setStatus({ type: 'error', message: 'Generate content first, then publish.' });
      return;
    }
    setPublishing(true);
    setStatus({ type: '', message: '' });
    try {
      // 1. Upload photos to Cloudflare Images
      const uploadedImages = [];
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i];
        if (p.status === 'uploaded' && p.cfId) {
          uploadedImages.push({ id: p.cfId, alt: generated.altTexts?.[i] || '' });
          continue;
        }
        setPhotos(prev => prev.map((pp, idx) => idx === i ? { ...pp, status: 'uploading' } : pp));
        try {
          const result = await api.uploadImage(p.file, { kid: slug, type: form.roomType });
          uploadedImages.push({ id: result.image.id, alt: generated.altTexts?.[i] || '' });
          setPhotos(prev => prev.map((pp, idx) =>
            idx === i ? { ...pp, status: 'uploaded', cfId: result.image.id } : pp
          ));
        } catch (err) {
          setPhotos(prev => prev.map((pp, idx) => idx === i ? { ...pp, status: 'error' } : pp));
          throw new Error(`Photo upload failed for ${p.file.name}: ${err.message}`);
        }
      }

      // 2. Build the JSON content file
      const kidData = {
        name: form.name,
        age: parseInt(form.age, 10),
        diagnosis: form.diagnosis,
        roomType: form.roomType,
        slug,
        bio: generated.bio,
        shortDescription: generated.shortDescription,
        metaDescription: generated.metaDescription,
        photos: uploadedImages,
        jsonLd: generated.jsonLd,
        notes: form.notes,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 3. Commit to GitHub
      await api.commitFiles(
        [{ path: `src/content/kids/${slug}.json`, content: JSON.stringify(kidData, null, 2) }],
        `Add kid profile: ${form.name}`
      );

      setStatus({ type: 'success', message: `Published! ${form.name}'s profile is live. Site will rebuild in ~15 seconds.` });
    } catch (err) {
      setStatus({ type: 'error', message: `Publishing failed: ${err.message}` });
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div>
      <h2 style={{ fontFamily: font.display, fontSize: 24, marginBottom: 8 }}>Add Kid</h2>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>
        Create a new kid profile with AI-generated bio and SEO content.
      </p>

      <StatusBanner {...status} onDismiss={() => setStatus({ type: '', message: '' })} />

      {/* Basic Info */}
      <div style={s.card}>
        <h3 style={{ fontFamily: font.display, fontSize: 17, marginBottom: 20 }}>Basic Information</h3>
        <div style={s.row}>
          <div style={{ flex: 2 }}>
            <Field label="Child's Name" required>
              <Input value={form.name} onChange={update('name')} placeholder="e.g. Amari" />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Age" required>
              <Input type="number" min="0" max="18" value={form.age} onChange={update('age')} placeholder="e.g. 8" />
            </Field>
          </div>
        </div>
        <Field label="Diagnosis / Condition" required>
          <Textarea value={form.diagnosis} onChange={update('diagnosis')} rows={2}
            placeholder="e.g. Cerebral palsy, uses a wheelchair. Loves drawing and dinosaurs." />
        </Field>
        <Field label="Room Type" required>
          <Select options={ROOM_TYPES} value={form.roomType} onChange={update('roomType')}
            placeholder="Select room type…" />
        </Field>
        <Field label="Additional Notes" hint="Interests, personality traits, family details — helps AI write a better bio.">
          <Textarea value={form.notes} onChange={update('notes')} rows={3}
            placeholder="e.g. Amari loves space and wants to be an astronaut. Lives with mom and two siblings." />
        </Field>
      </div>

      {/* Photos */}
      <div style={s.card}>
        <h3 style={{ fontFamily: font.display, fontSize: 17, marginBottom: 20 }}>Photos</h3>
        <ImageDropZone files={photos} setFiles={setPhotos} />
      </div>

      {/* AI Generation */}
      <div style={s.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ fontFamily: font.display, fontSize: 17, margin: 0 }}>AI-Generated Content</h3>
          <button
            onClick={generateContent}
            disabled={aiLoading}
            style={{
              ...s.btnPrimary,
              background: C.purple,
              color: C.white,
              opacity: aiLoading ? 0.7 : 1,
            }}
          >
            {aiLoading ? <><Spinner /> Generating…</> : '✨ Generate with AI'}
          </button>
        </div>

        {generated ? (
          <div>
            <Field label="Bio">
              <Textarea value={generated.bio} rows={6}
                onChange={(e) => setGenerated(g => ({ ...g, bio: e.target.value }))} />
            </Field>
            <div style={s.row}>
              <div style={{ flex: 1 }}>
                <Field label="Short Description">
                  <Input value={generated.shortDescription}
                    onChange={(e) => setGenerated(g => ({ ...g, shortDescription: e.target.value }))} />
                </Field>
              </div>
              <div style={{ flex: 1 }}>
                <Field label="Meta Description" hint="Under 160 characters">
                  <Input value={generated.metaDescription}
                    onChange={(e) => setGenerated(g => ({ ...g, metaDescription: e.target.value }))} />
                </Field>
              </div>
            </div>
            {generated.altTexts && generated.altTexts.length > 0 && (
              <div>
                <label style={s.label}>Photo Alt Texts</label>
                {generated.altTexts.map((alt, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                    {photos[i] && (
                      <img src={photos[i].preview} alt="" style={{
                        width: 40, height: 40, borderRadius: 6, objectFit: 'cover',
                      }} />
                    )}
                    <input
                      style={{ ...s.input, flex: 1 }}
                      value={alt}
                      onChange={(e) => {
                        const newAlts = [...generated.altTexts];
                        newAlts[i] = e.target.value;
                        setGenerated(g => ({ ...g, altTexts: newAlts }));
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{
            padding: '40px 20px',
            textAlign: 'center',
            color: C.textMuted,
            fontSize: 14,
          }}>
            Fill in the basic info above, then click "Generate with AI" to create the bio, descriptions, and SEO content.
          </div>
        )}
      </div>

      {/* Publish */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginBottom: 40 }}>
        <button style={s.btnSecondary} onClick={() => {
          setForm({ name: '', age: '', diagnosis: '', roomType: '', notes: '' });
          setPhotos([]);
          setGenerated(null);
          setStatus({ type: '', message: '' });
        }}>
          Clear Form
        </button>
        <button
          onClick={publish}
          disabled={publishing || !generated}
          style={{
            ...s.btnPrimary,
            fontSize: 15,
            padding: '12px 32px',
            opacity: publishing || !generated ? 0.6 : 1,
          }}
        >
          {publishing ? <><Spinner /> Publishing…</> : '🚀 Publish'}
        </button>
      </div>
    </div>
  );
}


// ─── Add Room ──────────────────────────────────────────

function AddRoom() {
  const [form, setForm] = useState({
    kidName: '', roomType: '', designNotes: '', features: '', partners: '',
  });
  const [beforePhotos, setBeforePhotos] = useState([]);
  const [afterPhotos, setAfterPhotos] = useState([]);
  const [generated, setGenerated] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [status, setStatus] = useState({ type: '', message: '' });

  const update = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }));
  const slug = `${form.kidName}-${form.roomType}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const generateContent = async () => {
    if (!form.roomType) {
      setStatus({ type: 'error', message: 'Please select a room type.' });
      return;
    }
    setAiLoading(true);
    setStatus({ type: '', message: '' });
    try {
      const result = await api.aiGenerate('room-description', {
        kidName: form.kidName,
        roomType: form.roomType,
        designNotes: form.designNotes,
        features: form.features.split('\n').filter(Boolean),
        partners: form.partners.split('\n').filter(Boolean),
      });
      setGenerated(result.generated);
      setStatus({ type: 'success', message: 'Room content generated! Review below.' });
    } catch (err) {
      setStatus({ type: 'error', message: `AI generation failed: ${err.message}` });
    } finally {
      setAiLoading(false);
    }
  };

  const publish = async () => {
    if (!generated) {
      setStatus({ type: 'error', message: 'Generate content first.' });
      return;
    }
    setPublishing(true);
    setStatus({ type: '', message: '' });
    try {
      // Upload all photos
      const uploadPhotos = async (photoList, setPhotoList, label) => {
        const uploaded = [];
        for (let i = 0; i < photoList.length; i++) {
          const p = photoList[i];
          if (p.status === 'uploaded' && p.cfId) {
            uploaded.push({ id: p.cfId });
            continue;
          }
          setPhotoList(prev => prev.map((pp, idx) => idx === i ? { ...pp, status: 'uploading' } : pp));
          try {
            const res = await api.uploadImage(p.file, { room: slug, type: label });
            uploaded.push({ id: res.image.id });
            setPhotoList(prev => prev.map((pp, idx) => idx === i ? { ...pp, status: 'uploaded', cfId: res.image.id } : pp));
          } catch (err) {
            setPhotoList(prev => prev.map((pp, idx) => idx === i ? { ...pp, status: 'error' } : pp));
            throw new Error(`${label} photo upload failed: ${err.message}`);
          }
        }
        return uploaded;
      };

      const beforeImages = await uploadPhotos(beforePhotos, setBeforePhotos, 'before');
      const afterImages = await uploadPhotos(afterPhotos, setAfterPhotos, 'after');

      const roomData = {
        kidName: form.kidName,
        roomType: form.roomType,
        slug,
        description: generated.description,
        shortDescription: generated.shortDescription,
        metaDescription: generated.metaDescription,
        featuresList: generated.featuresList,
        designNotes: form.designNotes,
        partners: form.partners.split('\n').filter(Boolean),
        beforePhotos: beforeImages,
        afterPhotos: afterImages,
        jsonLd: generated.jsonLd,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await api.commitFiles(
        [{ path: `src/content/rooms/${slug}.json`, content: JSON.stringify(roomData, null, 2) }],
        `Add room: ${form.kidName || 'New'} ${form.roomType}`
      );

      setStatus({ type: 'success', message: 'Room published! Site rebuilds in ~15 seconds.' });
    } catch (err) {
      setStatus({ type: 'error', message: `Publishing failed: ${err.message}` });
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div>
      <h2 style={{ fontFamily: font.display, fontSize: 24, marginBottom: 8 }}>Add Room</h2>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>
        Document a room makeover with before/after photos and AI-generated descriptions.
      </p>

      <StatusBanner {...status} onDismiss={() => setStatus({ type: '', message: '' })} />

      <div style={s.card}>
        <h3 style={{ fontFamily: font.display, fontSize: 17, marginBottom: 20 }}>Room Details</h3>
        <div style={s.row}>
          <div style={{ flex: 1 }}>
            <Field label="Child's Name">
              <Input value={form.kidName} onChange={update('kidName')} placeholder="e.g. Amari" />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Room Type" required>
              <Select options={ROOM_TYPES} value={form.roomType} onChange={update('roomType')}
                placeholder="Select type…" />
            </Field>
          </div>
        </div>
        <Field label="Design Notes" hint="Colors, themes, inspiration, special requirements">
          <Textarea value={form.designNotes} onChange={update('designNotes')} rows={3}
            placeholder="e.g. Space theme with deep blue walls, glow-in-the-dark stars, wheelchair-accessible desk" />
        </Field>
        <Field label="Features" hint="One per line">
          <Textarea value={form.features} onChange={update('features')} rows={3}
            placeholder="Custom-built loft bed&#10;Wheelchair-accessible desk&#10;Sensory lighting system" />
        </Field>
        <Field label="Partners Involved" hint="One per line">
          <Textarea value={form.partners} onChange={update('partners')} rows={2}
            placeholder="Home Depot&#10;Sherwin-Williams" />
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={s.card}>
          <h3 style={{ fontFamily: font.display, fontSize: 17, marginBottom: 16 }}>Before Photos</h3>
          <ImageDropZone files={beforePhotos} setFiles={setBeforePhotos} label="Drop BEFORE photos" />
        </div>
        <div style={s.card}>
          <h3 style={{ fontFamily: font.display, fontSize: 17, marginBottom: 16 }}>After Photos</h3>
          <ImageDropZone files={afterPhotos} setFiles={setAfterPhotos} label="Drop AFTER photos" />
        </div>
      </div>

      <div style={s.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ fontFamily: font.display, fontSize: 17, margin: 0 }}>AI-Generated Content</h3>
          <button onClick={generateContent} disabled={aiLoading}
            style={{ ...s.btnPrimary, background: C.purple, color: C.white, opacity: aiLoading ? 0.7 : 1 }}>
            {aiLoading ? <><Spinner /> Generating…</> : '✨ Generate with AI'}
          </button>
        </div>

        {generated ? (
          <div>
            <Field label="Description">
              <Textarea value={generated.description} rows={5}
                onChange={(e) => setGenerated(g => ({ ...g, description: e.target.value }))} />
            </Field>
            <div style={s.row}>
              <div style={{ flex: 1 }}>
                <Field label="Short Description">
                  <Input value={generated.shortDescription}
                    onChange={(e) => setGenerated(g => ({ ...g, shortDescription: e.target.value }))} />
                </Field>
              </div>
              <div style={{ flex: 1 }}>
                <Field label="Meta Description">
                  <Input value={generated.metaDescription}
                    onChange={(e) => setGenerated(g => ({ ...g, metaDescription: e.target.value }))} />
                </Field>
              </div>
            </div>
            {generated.featuresList && (
              <Field label="Features List">
                <Textarea
                  value={generated.featuresList.join('\n')}
                  rows={4}
                  onChange={(e) => setGenerated(g => ({
                    ...g, featuresList: e.target.value.split('\n').filter(Boolean)
                  }))}
                />
              </Field>
            )}
          </div>
        ) : (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: C.textMuted, fontSize: 14 }}>
            Fill in room details, then click "Generate with AI."
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginBottom: 40 }}>
        <button style={s.btnSecondary} onClick={() => {
          setForm({ kidName: '', roomType: '', designNotes: '', features: '', partners: '' });
          setBeforePhotos([]); setAfterPhotos([]);
          setGenerated(null); setStatus({ type: '', message: '' });
        }}>Clear Form</button>
        <button onClick={publish} disabled={publishing || !generated}
          style={{ ...s.btnPrimary, fontSize: 15, padding: '12px 32px', opacity: publishing || !generated ? 0.6 : 1 }}>
          {publishing ? <><Spinner /> Publishing…</> : '🚀 Publish'}
        </button>
      </div>
    </div>
  );
}


// ─── Add Partner ───────────────────────────────────────

const PARTNER_TYPES = [
  { value: 'construction', label: 'Construction' },
  { value: 'design', label: 'Design' },
  { value: 'materials', label: 'Materials / Supplies' },
  { value: 'financial', label: 'Financial / Sponsor' },
  { value: 'volunteer', label: 'Volunteer Organization' },
  { value: 'media', label: 'Media / PR' },
  { value: 'other', label: 'Other' },
];

function AddPartner() {
  const [form, setForm] = useState({
    name: '', type: '', website: '', description: '',
  });
  const [logo, setLogo] = useState([]);
  const [publishing, setPublishing] = useState(false);
  const [status, setStatus] = useState({ type: '', message: '' });

  const update = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }));
  const slug = form.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const publish = async () => {
    if (!form.name || !form.type) {
      setStatus({ type: 'error', message: 'Name and type are required.' });
      return;
    }
    setPublishing(true);
    setStatus({ type: '', message: '' });
    try {
      let logoImage = null;
      if (logo.length > 0 && logo[0].status !== 'uploaded') {
        setLogo(prev => prev.map(l => ({ ...l, status: 'uploading' })));
        const res = await api.uploadImage(logo[0].file, { partner: slug });
        logoImage = { id: res.image.id };
        setLogo(prev => prev.map(l => ({ ...l, status: 'uploaded', cfId: res.image.id })));
      } else if (logo.length > 0) {
        logoImage = { id: logo[0].cfId };
      }

      const partnerData = {
        name: form.name,
        slug,
        type: form.type,
        website: form.website,
        description: form.description,
        logo: logoImage,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await api.commitFiles(
        [{ path: `src/content/partners/${slug}.json`, content: JSON.stringify(partnerData, null, 2) }],
        `Add partner: ${form.name}`
      );

      setStatus({ type: 'success', message: `${form.name} added as a partner!` });
    } catch (err) {
      setStatus({ type: 'error', message: `Publishing failed: ${err.message}` });
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div>
      <h2 style={{ fontFamily: font.display, fontSize: 24, marginBottom: 8 }}>Add Partner</h2>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>
        Add a construction, design, or sponsor partner.
      </p>

      <StatusBanner {...status} onDismiss={() => setStatus({ type: '', message: '' })} />

      <div style={s.card}>
        <h3 style={{ fontFamily: font.display, fontSize: 17, marginBottom: 20 }}>Partner Details</h3>
        <div style={s.row}>
          <div style={{ flex: 1 }}>
            <Field label="Company Name" required>
              <Input value={form.name} onChange={update('name')} placeholder="e.g. Home Depot" />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Partner Type" required>
              <Select options={PARTNER_TYPES} value={form.type} onChange={update('type')}
                placeholder="Select type…" />
            </Field>
          </div>
        </div>
        <Field label="Website URL">
          <Input type="url" value={form.website} onChange={update('website')}
            placeholder="https://www.example.com" />
        </Field>
        <Field label="Description" hint="Brief description of how they support SOARD">
          <Textarea value={form.description} onChange={update('description')} rows={3}
            placeholder="e.g. Donates materials and volunteer labor for all SOARD room builds." />
        </Field>
      </div>

      <div style={s.card}>
        <h3 style={{ fontFamily: font.display, fontSize: 17, marginBottom: 16 }}>Logo</h3>
        <ImageDropZone files={logo} setFiles={setLogo} multiple={false} label="Drop partner logo here" />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginBottom: 40 }}>
        <button style={s.btnSecondary} onClick={() => {
          setForm({ name: '', type: '', website: '', description: '' });
          setLogo([]); setStatus({ type: '', message: '' });
        }}>Clear Form</button>
        <button onClick={publish} disabled={publishing}
          style={{ ...s.btnPrimary, fontSize: 15, padding: '12px 32px', opacity: publishing ? 0.6 : 1 }}>
          {publishing ? <><Spinner /> Publishing…</> : '🚀 Publish'}
        </button>
      </div>
    </div>
  );
}


// ─── Add Financial Doc ─────────────────────────────────

const DOC_TYPES = [
  { value: '990', label: 'IRS Form 990' },
  { value: 'annual-report', label: 'Annual Report' },
  { value: 'audit', label: 'Audit Report' },
  { value: 'other', label: 'Other' },
];

function AddFinancial() {
  const [form, setForm] = useState({
    title: '', type: '', year: new Date().getFullYear().toString(), url: '',
  });
  const [file, setFile] = useState([]);
  const [publishing, setPublishing] = useState(false);
  const [status, setStatus] = useState({ type: '', message: '' });

  const update = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }));
  const slug = `${form.type}-${form.year}`.replace(/[^a-z0-9]+/g, '-');

  const publish = async () => {
    if (!form.title || !form.type || !form.year) {
      setStatus({ type: 'error', message: 'Title, type, and year are required.' });
      return;
    }
    setPublishing(true);
    setStatus({ type: '', message: '' });
    try {
      // Note: For PDFs, we store the URL if provided, or upload to CF Images
      // (CF Images can store PDFs as well, or use a separate storage)
      let fileUrl = form.url;
      if (file.length > 0 && !fileUrl) {
        // Upload the file - for now store the reference
        setFile(prev => prev.map(f => ({ ...f, status: 'uploading' })));
        const res = await api.uploadImage(file[0].file, { financial: slug });
        fileUrl = res.image.variants?.[0] || res.image.id;
        setFile(prev => prev.map(f => ({ ...f, status: 'uploaded', cfId: res.image.id })));
      }

      const financialData = {
        title: form.title,
        slug,
        type: form.type,
        year: parseInt(form.year, 10),
        url: fileUrl,
        createdAt: new Date().toISOString(),
      };

      await api.commitFiles(
        [{ path: `src/content/financials/${slug}.json`, content: JSON.stringify(financialData, null, 2) }],
        `Add financial doc: ${form.title}`
      );

      setStatus({ type: 'success', message: `${form.title} published!` });
    } catch (err) {
      setStatus({ type: 'error', message: `Publishing failed: ${err.message}` });
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div>
      <h2 style={{ fontFamily: font.display, fontSize: 24, marginBottom: 8 }}>Add Financial Document</h2>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>
        Upload 990 forms, annual reports, and audit documents for transparency.
      </p>

      <StatusBanner {...status} onDismiss={() => setStatus({ type: '', message: '' })} />

      <div style={s.card}>
        <h3 style={{ fontFamily: font.display, fontSize: 17, marginBottom: 20 }}>Document Details</h3>
        <Field label="Document Title" required>
          <Input value={form.title} onChange={update('title')}
            placeholder="e.g. IRS Form 990 — Fiscal Year 2024" />
        </Field>
        <div style={s.row}>
          <div style={{ flex: 1 }}>
            <Field label="Document Type" required>
              <Select options={DOC_TYPES} value={form.type} onChange={update('type')}
                placeholder="Select type…" />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Year" required>
              <Input type="number" min="2010" max="2030" value={form.year} onChange={update('year')} />
            </Field>
          </div>
        </div>
        <Field label="External URL" hint="If the document is hosted elsewhere (e.g. GuideStar)">
          <Input type="url" value={form.url} onChange={update('url')}
            placeholder="https://..." />
        </Field>
      </div>

      <div style={s.card}>
        <h3 style={{ fontFamily: font.display, fontSize: 17, marginBottom: 16 }}>Upload PDF</h3>
        <ImageDropZone files={file} setFiles={setFile} multiple={false}
          label="Drop PDF here (or provide URL above)" />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginBottom: 40 }}>
        <button style={s.btnSecondary} onClick={() => {
          setForm({ title: '', type: '', year: new Date().getFullYear().toString(), url: '' });
          setFile([]); setStatus({ type: '', message: '' });
        }}>Clear Form</button>
        <button onClick={publish} disabled={publishing}
          style={{ ...s.btnPrimary, fontSize: 15, padding: '12px 32px', opacity: publishing ? 0.6 : 1 }}>
          {publishing ? <><Spinner /> Publishing…</> : '🚀 Publish'}
        </button>
      </div>
    </div>
  );
}


// ─── Main Admin App ────────────────────────────────────

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'add-kid', label: 'Add Kid', icon: '👧🏽' },
  { id: 'add-room', label: 'Add Room', icon: '🏠' },
  { id: 'add-partner', label: 'Add Partner', icon: '🤝' },
  { id: 'add-financial', label: 'Add Financial', icon: '📄' },
];

export default function AdminApp() {
  const [page, setPage] = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const renderPage = () => {
    switch (page) {
      case 'dashboard': return <Dashboard />;
      case 'add-kid': return <AddKid />;
      case 'add-room': return <AddRoom />;
      case 'add-partner': return <AddPartner />;
      case 'add-financial': return <AddFinancial />;
      default: return <Dashboard />;
    }
  };

  return (
    <>
      <style>{`
        @keyframes admin-spin { to { transform: rotate(360deg); } }
        .admin-nav-item { transition: all 0.15s; }
        .admin-nav-item:hover { background: rgba(255,213,0,0.1) !important; }
        input:focus, textarea:focus, select:focus {
          border-color: ${C.yellow} !important;
          box-shadow: 0 0 0 3px rgba(255,213,0,0.15);
        }
        @media (max-width: 768px) {
          .admin-sidebar { 
            position: fixed !important; 
            z-index: 100; 
            transform: translateX(${sidebarOpen ? '0' : '-100%'});
            transition: transform 0.2s;
          }
          .admin-main { margin-left: 0 !important; }
        }
      `}</style>

      <div style={{ display: 'flex', minHeight: '100vh' }}>
        {/* Sidebar */}
        <aside className="admin-sidebar" style={{
          width: 260,
          background: C.dark,
          color: C.white,
          display: 'flex',
          flexDirection: 'column',
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          zIndex: 50,
        }}>
          {/* Logo */}
          <div style={{
            padding: '24px 20px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 36, height: 36, borderRadius: '50%',
                background: C.yellow,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18,
              }}>☀️</div>
              <div>
                <div style={{
                  fontFamily: font.display,
                  fontSize: 15,
                  fontWeight: 700,
                }}>SOARD</div>
                <div style={{
                  fontSize: 11,
                  color: 'rgba(255,255,255,0.5)',
                  letterSpacing: '0.05em',
                }}>CONTENT MANAGER</div>
              </div>
            </div>
          </div>

          {/* Nav */}
          <nav style={{ flex: 1, padding: '16px 12px' }}>
            {NAV_ITEMS.map(item => (
              <button
                key={item.id}
                className="admin-nav-item"
                onClick={() => { setPage(item.id); setSidebarOpen(false); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  width: '100%',
                  padding: '10px 12px',
                  border: 'none',
                  borderRadius: 8,
                  background: page === item.id ? 'rgba(255,213,0,0.15)' : 'transparent',
                  color: page === item.id ? C.yellow : 'rgba(255,255,255,0.7)',
                  fontFamily: font.body,
                  fontSize: 14,
                  fontWeight: page === item.id ? 600 : 400,
                  cursor: 'pointer',
                  textAlign: 'left',
                  marginBottom: 4,
                }}
              >
                <span style={{ fontSize: 18 }}>{item.icon}</span>
                {item.label}
              </button>
            ))}
          </nav>

          {/* Footer */}
          <div style={{
            padding: '16px 20px',
            borderTop: '1px solid rgba(255,255,255,0.08)',
            fontSize: 12,
            color: 'rgba(255,255,255,0.35)',
          }}>
            sunshineonaranneyday.com
          </div>
        </aside>

        {/* Main content */}
        <main className="admin-main" style={{
          flex: 1,
          marginLeft: 260,
          background: C.cream,
          minHeight: '100vh',
        }}>
          {/* Top bar */}
          <header style={{
            padding: '16px 32px',
            background: C.white,
            borderBottom: `1px solid ${C.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              style={{
                display: 'none',
                background: 'none',
                border: 'none',
                fontSize: 20,
                cursor: 'pointer',
                padding: 4,
              }}
              className="mobile-menu-btn"
            >☰</button>
            <div style={{ fontSize: 13, color: C.textMuted }}>
              {NAV_ITEMS.find(n => n.id === page)?.icon}{' '}
              {NAV_ITEMS.find(n => n.id === page)?.label}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <a href="/" target="_blank" rel="noopener"
                style={{ fontSize: 13, color: C.purple, textDecoration: 'none', fontWeight: 500 }}>
                View Site ↗
              </a>
            </div>
          </header>

          {/* Page content */}
          <div style={{ padding: '32px', maxWidth: 900 }}>
            {renderPage()}
          </div>
        </main>
      </div>
    </>
  );
}
