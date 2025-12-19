/* global React, ReactDOM, supabase, Chart */

// Supabase client - will be initialized when available
const SUPABASE_URL = 'https://vpcpclszokaxfqsdlpyw.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_jo0brwXqeuQp4YxCdLwwTw_xU8DpLad';

// Singleton pattern to ensure only one client instance
let supabaseClient = null;

function getSupabaseClient() {
  // Return existing client if already created
  if (supabaseClient) {
    return supabaseClient;
  }

  if (typeof window === 'undefined' || !window.supabase) {
    return null;
  }

  try {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return supabaseClient;
  } catch (err) {
    console.error('Error creating Supabase client:', err);
    return null;
  }
}

async function sb(promise, label, meta = {}) {
  // Small helper to ensure we ALWAYS see the underlying Supabase error (incl. RLS failures).
  try {
    const res = await promise;
    if (res?.error) {
      const e = res.error;
      console.error(`[supabase] ${label}`, {
        ...meta,
        error: {
          message: e?.message,
          code: e?.code,
          details: e?.details,
          hint: e?.hint,
        },
        status: res.status,
        count: res.count,
      });
    }
    return res;
  } catch (err) {
    console.error(`[supabase] ${label} threw`, { ...meta, err });
    throw err;
  }
}

// Try to initialize immediately
getSupabaseClient();

// ---- Auth & Context ---------------------------------------------------------

const AuthContext = React.createContext(null);

function AuthProvider({ children }) {
  const [user, setUser] = React.useState(null);
  const [profile, setProfile] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [clientReady, setClientReady] = React.useState(false);

  // Wait for Supabase client to be ready
  React.useEffect(() => {
    let checkInterval = null;
    let timeout = null;
    let mounted = true;
    
    const checkClient = () => {
      // Use singleton function to get/create client (prevents multiple instances)
      const client = getSupabaseClient();
      if (client) {
        if (mounted) {
          setClientReady(true);
        }
        if (checkInterval) clearInterval(checkInterval);
        if (timeout) clearTimeout(timeout);
        return true;
      }
      return false;
    };

    // Check immediately
    if (checkClient()) {
      // Client ready immediately - ensure loading can proceed
    } else {
      // If not ready, check every 100ms for up to 5 seconds
      checkInterval = setInterval(() => {
        if (checkClient()) {
          clearInterval(checkInterval);
        }
      }, 100);

      // Timeout after 5 seconds - ALWAYS stop loading
      timeout = setTimeout(() => {
        clearInterval(checkInterval);
        if (mounted) {
          console.warn('Supabase client initialization timeout - proceeding anyway');
          setLoading(false);
          setClientReady(false);
        }
      }, 5000);
    }

    return () => {
      mounted = false;
      if (checkInterval) clearInterval(checkInterval);
      if (timeout) clearTimeout(timeout);
    };
  }, []);

  React.useEffect(() => {
    const client = getSupabaseClient();
    if (!clientReady || !client) {
      // Safety timeout: ALWAYS stop loading after 5 seconds even if client isn't ready
      const timeout = setTimeout(() => {
        setLoading(false);
      }, 5000);
      return () => clearTimeout(timeout);
    }

    let mounted = true;
    let safetyTimeout = setTimeout(() => {
      if (mounted) {
        console.warn('Auth initialization taking too long - stopping load');
        setLoading(false);
      }
    }, 5000);
    
    async function load() {
      const client = getSupabaseClient();
      if (!mounted || !client) {
        if (safetyTimeout) clearTimeout(safetyTimeout);
        return;
      }
      
      setLoading(true);
      
      try {
        // Use getSession instead of getUser for better compatibility
        const { data: { session }, error: sessionError } = await client.auth.getSession();
        
        // ALWAYS check mounted before setting state
        if (!mounted) {
          if (safetyTimeout) clearTimeout(safetyTimeout);
          return;
        }
        
        // Handle session error - ALWAYS set loading to false
        if (sessionError) {
          console.error('Session error:', sessionError);
          setUser(null);
          setProfile(null);
          setLoading(false);
          if (safetyTimeout) clearTimeout(safetyTimeout);
          return;
        }

        // Handle no session - ALWAYS set loading to false
        if (!session?.user) {
          setUser(null);
          setProfile(null);
          setLoading(false);
          if (safetyTimeout) clearTimeout(safetyTimeout);
          return;
        }

        // User is authenticated
        setUser(session.user);

        // Load profile (non-blocking - don't fail if profile doesn't exist)
        try {
          const { data: profileData, error: profileError } = await client
            .from('profiles')
            .select('id, full_name, email, role')
            .eq('id', session.user.id)
            .single();

          if (!mounted) {
            if (safetyTimeout) clearTimeout(safetyTimeout);
            return;
          }

          if (profileError) {
            console.error('Profile fetch error:', profileError);
            // Don't fail completely if profile doesn't exist yet
          }

          // ALWAYS set loading to false after profile attempt
          if (profileData) {
            setProfile(profileData);
          }
          setLoading(false);
          if (safetyTimeout) clearTimeout(safetyTimeout);
        } catch (profileErr) {
          console.error('Profile error:', profileErr);
          if (mounted) {
            // ALWAYS set loading to false even on profile error
            setLoading(false);
            if (safetyTimeout) clearTimeout(safetyTimeout);
          }
        }
      } catch (err) {
        console.error('Auth load error:', err);
        if (mounted) {
          // ALWAYS set loading to false on any error
          setUser(null);
          setProfile(null);
          setLoading(false);
          if (safetyTimeout) clearTimeout(safetyTimeout);
        }
      }
    }

    // Initial load
    load();

    // Listen for auth changes
    let subscription = null;
    try {
      const {
        data: { subscription: sub },
      } = client.auth.onAuthStateChange((event, session) => {
        if (!mounted) return;
        
        // Handle sign out or no session - ALWAYS set loading to false
        if (event === 'SIGNED_OUT' || !session) {
          setUser(null);
          setProfile(null);
          setLoading(false);
        } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          // Reload user data
          load();
        } else if (event === 'INITIAL_SESSION') {
          // Initial session event - ensure loading stops
          if (!session) {
            setUser(null);
            setProfile(null);
            setLoading(false);
          }
        }
      });
      subscription = sub;
    } catch (err) {
      console.error('Error setting up auth listener:', err);
      if (mounted) {
        // ALWAYS set loading to false if listener setup fails
        setLoading(false);
        if (safetyTimeout) clearTimeout(safetyTimeout);
      }
    }

    return () => {
      mounted = false;
      if (safetyTimeout) clearTimeout(safetyTimeout);
      if (subscription) subscription.unsubscribe();
    };
  }, [clientReady]);

  const value = React.useMemo(
    () => ({
      supabase: getSupabaseClient(),
      user,
      profile,
      loading,
      async signIn(email, password) {
        const client = getSupabaseClient();
        if (!client) throw new Error('Supabase client not initialized');
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
      },
      async signUp(email, password, fullName) {
        const client = getSupabaseClient();
        if (!client) throw new Error('Supabase client not initialized');
        const { data, error } = await client.auth.signUp({
          email,
          password,
          options: { data: { full_name: fullName } },
        });
        if (error) throw error;
        return data;
      },
      async signOut() {
        const client = getSupabaseClient();
        if (!client) return;
        await client.auth.signOut();
        setUser(null);
        setProfile(null);
      },
      async updateProfile(updates) {
        const client = getSupabaseClient();
        if (!user || !client) {
          console.error('[profiles] updateProfile called without user/client', { userId: user?.id });
          return { data: null, error: new Error('Not authenticated') };
        }
        const { data, error } = await sb(
          client.from('profiles').update(updates).eq('id', user.id).select().single(),
          'profiles:updateSelf',
          { userId: user.id, updates }
        );
        if (!error && data) setProfile(data);
        return { data, error };
      },
    }),
    // include clientReady so ctx.supabase updates as soon as the client becomes available
    [user, profile, loading, clientReady]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

// ---- Router ----------------------------------------------------------------

const ROUTES = {
  DASHBOARD: 'dashboard',
  STUDENTS: 'students',
  COURSES: 'courses',
  MY_COURSES: 'my-courses',
  COURSE_CATALOG: 'course-catalog',
  MY_ATTENDANCE: 'my-attendance',
  ENROLLMENTS: 'enrollments',
  ATTENDANCE: 'attendance',
  GRADES: 'grades',
  MY_GRADES: 'my-grades',
  DEPARTMENTS: 'departments',
  SEMESTERS: 'semesters',
  ANALYTICS: 'analytics',
  REPORTS: 'reports',
  ADMIN_USERS: 'admin-users',
  PROFILE: 'profile',
};

function useRoute() {
  const [route, setRoute] = React.useState(() => {
    return window.location.hash.replace('#', '') || ROUTES.DASHBOARD;
  });

  React.useEffect(() => {
    function onHashChange() {
      const r = window.location.hash.replace('#', '') || ROUTES.DASHBOARD;
      setRoute(r);
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = React.useCallback((r) => {
    window.location.hash = r;
  }, []);

  return { route, navigate };
}

// ---- Login Page ------------------------------------------------------------

function LoginPage() {
  const { signIn, signUp, loading } = useAuth();
  const [isLogin, setIsLogin] = React.useState(true);
  const [email, setEmail] = React.useState('');
  const [fullName, setFullName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [info, setInfo] = React.useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    try {
      setBusy(true);
      if (isLogin) {
        await signIn(email, password);
      } else {
        const data = await signUp(email, password, fullName);
        if (data?.user && !data.session) {
          setInfo('Account created. Please check your email to confirm your address before logging in.');
        } else {
          setInfo('Account created successfully.');
        }
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md transform transition-all hover:scale-[1.02] animate-slide-up">
        <div className="flex items-center justify-center mb-6">
          <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-xl flex items-center justify-center shadow-lg">
            <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </div>
        </div>
        <h1 className="text-3xl font-bold text-center mb-2 bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
          {isLogin ? 'Welcome Back' : 'Get Started'}
        </h1>
        <p className="text-gray-600 text-center mb-6">
          {isLogin ? 'Sign in to your College Management account' : 'Create your account to begin'}
        </p>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm animate-slide-down">
            {error}
          </div>
        )}
        {info && !error && (
          <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 rounded-lg text-sm animate-slide-down">
            {info}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {!isLogin && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
              <input
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
              />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <button
            className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-3 rounded-lg font-semibold hover:from-blue-700 hover:to-indigo-700 transform hover:scale-[1.02] transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={busy || loading}
            type="submit"
          >
            {busy ? 'Please wait...' : isLogin ? 'Sign In' : 'Create Account'}
          </button>
        </form>
        <button
          type="button"
          className="mt-4 w-full text-blue-600 hover:text-blue-700 font-medium transition-colors"
          onClick={() => setIsLogin((v) => !v)}
        >
          {isLogin ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  );
}

// ---- Sidebar ----------------------------------------------------------------

function Sidebar({ route, navigate, profile, onLogout }) {
  const role = profile?.role;
  const [mobileOpen, setMobileOpen] = React.useState(false);

  const LinkButton = ({ id, label, icon, roles, badge }) => {
    if (roles && (!role || !roles.includes(role))) return null;
    const active = route === id;
    return (
      <button
        className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all transform hover:scale-[1.02] ${
          active
            ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg'
            : 'text-gray-700 hover:bg-gray-100'
        }`}
        onClick={() => {
          navigate(id);
          setMobileOpen(false);
        }}
      >
        {icon && <span className="text-xl">{icon}</span>}
        <span className="flex-1 text-left font-medium">{label}</span>
        {badge && (
          <span className="bg-red-500 text-white text-xs px-2 py-0.5 rounded-full">{badge}</span>
        )}
      </button>
    );
  };

  const menuItems = [
    { id: ROUTES.DASHBOARD, label: 'Dashboard', icon: '📊', roles: null },
    { id: ROUTES.STUDENTS, label: 'Students', icon: '👥', roles: ['admin', 'faculty'] },
    { id: ROUTES.COURSES, label: 'Courses', icon: '📚', roles: ['admin', 'faculty'] },
    { id: ROUTES.MY_COURSES, label: 'My Courses', icon: '🎓', roles: ['student'] },
    { id: ROUTES.COURSE_CATALOG, label: 'Course Catalog', icon: '📖', roles: ['student'] },
    { id: ROUTES.ATTENDANCE, label: 'Attendance', icon: '✅', roles: ['admin', 'faculty'] },
    { id: ROUTES.MY_ATTENDANCE, label: 'My Attendance', icon: '📅', roles: ['student'] },
    { id: ROUTES.ENROLLMENTS, label: 'Enrollments', icon: '📝', roles: ['admin'] },
    { id: ROUTES.GRADES, label: 'Grades', icon: '📊', roles: ['admin', 'faculty'] },
    { id: ROUTES.MY_GRADES, label: 'My Grades', icon: '🎯', roles: ['student'] },
    { id: ROUTES.DEPARTMENTS, label: 'Departments', icon: '🏛️', roles: ['admin'] },
    { id: ROUTES.SEMESTERS, label: 'Semesters', icon: '📆', roles: ['admin'] },
    { id: ROUTES.ANALYTICS, label: 'Analytics', icon: '📈', roles: ['admin'] },
    { id: ROUTES.REPORTS, label: 'Reports', icon: '📄', roles: ['admin'] },
    { id: ROUTES.ADMIN_USERS, label: 'User Management', icon: '👤', roles: ['admin'] },
    { id: ROUTES.PROFILE, label: 'Profile', icon: '⚙️', roles: null },
  ];

  return (
    <>
      {/* Mobile menu button */}
      <button
        className="lg:hidden fixed top-4 left-4 z-50 bg-white p-2 rounded-lg shadow-lg"
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-40 w-64 bg-white shadow-xl transform transition-transform duration-300 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="h-full flex flex-col p-4">
          <div className="mb-6">
            <div className="text-2xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent mb-2">
              College CMS
            </div>
            <div className="text-xs text-gray-500">Management System</div>
          </div>

          <nav className="flex-1 space-y-2 overflow-y-auto">
            {menuItems.map((item) => (
              <LinkButton key={item.id} {...item} />
            ))}
          </nav>

          <div className="mt-4 pt-4 border-t border-gray-200">
            <div className="mb-3">
              <div className="font-semibold text-gray-800">{profile?.full_name || profile?.email}</div>
              <span
                className={`inline-block mt-1 px-2 py-1 rounded-full text-xs font-medium ${
                  role === 'admin'
                    ? 'bg-purple-100 text-purple-700'
                    : role === 'faculty'
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-green-100 text-green-700'
                }`}
              >
                {role || 'unknown'}
              </span>
            </div>
            <button
              className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 rounded-lg font-medium transition-colors"
              onClick={onLogout}
            >
              Logout
            </button>
          </div>
        </div>
      </aside>

      {/* Overlay for mobile */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black bg-opacity-50 z-30"
          onClick={() => setMobileOpen(false)}
        />
      )}
    </>
  );
}

// ---- Dashboard Page --------------------------------------------------------

function DashboardPage() {
  const { profile, supabase, user } = useAuth();
  const [stats, setStats] = React.useState(null);
  const [recentCourses, setRecentCourses] = React.useState([]);
  const [chartRef, setChartRef] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    // IMPORTANT: only fetch once we have an authenticated user id (avoids pre-session calls)
    if (!supabase || !profile || !user?.id) return;
    async function load() {
      setLoading(true);
      try {
        if (profile.role === 'admin') {
          const [studentsRes, coursesRes, semestersRes, enrollRes, recentRes] = await Promise.all([
            sb(
              supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'student'),
              'profiles:countStudents',
              { userId: user.id }
            ),
            sb(supabase.from('courses').select('id', { count: 'exact', head: true }), 'courses:count', {
              userId: user.id,
            }),
            sb(
              supabase.from('semesters').select('id', { count: 'exact', head: true }).eq('is_active', true),
              'semesters:countActive',
              { userId: user.id }
            ),
            sb(supabase.from('enrollments').select('id', { count: 'exact', head: true }), 'enrollments:count', {
              userId: user.id,
            }),
            sb(
              supabase.from('courses').select('*').order('created_at', { ascending: false }).limit(5),
              'courses:listRecent',
              { userId: user.id }
            ),
          ]);

          let studentCount = studentsRes.count || 0;
          if (studentsRes.error) {
            // Keep a best-effort fallback, but log it loudly.
            console.error('[dashboard] Student count failed; falling back to enrollments', {
              userId: user.id,
              error: studentsRes.error,
            });

            const { data: enrollData, error: enrollErr } = await sb(
              supabase.from('enrollments').select('student_id'),
              'enrollments:listStudentIdsForFallback',
              { userId: user.id }
            );
            if (!enrollErr && enrollData) {
              studentCount = new Set(enrollData.map((e) => e.student_id)).size;
            }
          }

          setStats({
            students: studentCount,
            courses: coursesRes.count || 0,
            activeSemesters: semestersRes.count || 0,
            enrollments: enrollRes.count || 0,
          });
          setRecentCourses(recentRes.data || []);
        } else if (profile.role === 'faculty') {
          const { data: myCourses, error: myCoursesErr } = await sb(
            supabase.from('courses').select('id').eq('faculty_id', profile.id),
            'courses:listFacultyCourseIds',
            { userId: user.id, facultyId: profile.id }
          );
          const courseIds = myCourses?.map((c) => c.id) || [];

          const [enrollCountRes, gradesCountRes] = await Promise.all([
            sb(
              supabase
                .from('enrollments')
                .select('id', { count: 'exact', head: true })
                .in('course_id', courseIds.length ? courseIds : ['00000000-0000-0000-0000-000000000000']),
              'enrollments:countForFacultyCourses',
              { userId: user.id, courseIdsCount: courseIds.length }
            ),
            sb(
              supabase.from('grades').select('id', { count: 'exact', head: true }).in('assignment_id', []),
              'grades:countPlaceholder',
              { userId: user.id }
            ),
          ]);

          let myStudentsCount = 0;
          if (!myCoursesErr && courseIds.length) {
            const { data: enrollData } = await sb(
              supabase.from('enrollments').select('student_id').in('course_id', courseIds),
              'enrollments:listStudentIdsForFacultyCourses',
              { userId: user.id, courseIdsCount: courseIds.length }
            );
            if (enrollData) {
              myStudentsCount = new Set(enrollData.map((e) => e.student_id)).size;
            }
          }

          setStats({
            students: myStudentsCount,
            courses: myCourses?.length || 0,
            activeSemesters: null,
            enrollments: enrollCountRes.count || 0,
            grades: gradesCountRes.count || 0,
          });
        } else {
          const [enrollRes, gradesRes, attRes] = await Promise.all([
            sb(
              supabase.from('enrollments').select('id', { count: 'exact', head: true }).eq('student_id', profile.id),
              'enrollments:countForStudent',
              { userId: user.id, studentId: profile.id }
            ),
            sb(supabase.from('grades').select('id', { count: 'exact', head: true }).eq('student_id', profile.id), 'grades:countForStudent', {
              userId: user.id,
              studentId: profile.id,
            }),
            sb(
              supabase.from('attendance').select('id', { count: 'exact', head: true }).eq('student_id', profile.id),
              'attendance:countForStudent',
              { userId: user.id, studentId: profile.id }
            ),
          ]);
          setStats({
            enrollments: enrollRes.count || 0,
            grades: gradesRes.count || 0,
            attendance: attRes.count || 0,
          });
        }
      } catch (e) {
        console.error('[dashboard] load failed', e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [supabase, profile, user?.id]);

  React.useEffect(() => {
    if (!chartRef || !stats || profile?.role !== 'admin') return;
    const ctx = chartRef.getContext('2d');
    const chart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Students', 'Courses', 'Active Semesters', 'Enrollments'],
        datasets: [
          {
            data: [stats.students, stats.courses, stats.activeSemesters, stats.enrollments],
            backgroundColor: ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b'],
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'bottom' },
        },
      },
    });
    return () => chart.destroy();
  }, [chartRef, stats, profile]);

  const StatCard = ({ title, value, icon, color, delay = 0 }) => (
    <div
      className={`bg-white rounded-xl shadow-lg p-6 transform hover:scale-105 transition-all animate-slide-up`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className={`w-12 h-12 rounded-lg bg-gradient-to-br ${color} flex items-center justify-center text-2xl`}>
          {icon}
        </div>
        <div className="text-3xl font-bold text-gray-800">{value}</div>
      </div>
      <div className="text-gray-600 font-medium">{title}</div>
    </div>
  );

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-2xl p-8 text-white shadow-2xl">
        <h1 className="text-4xl font-bold mb-2">
          Welcome back, {profile?.full_name || profile?.email}!
        </h1>
        <p className="text-blue-100 text-lg">
          {profile?.role === 'admin'
            ? 'Manage your college with powerful tools and insights'
            : profile?.role === 'faculty'
            ? 'Track your courses, students, and academic progress'
            : 'View your courses, grades, and academic progress'}
        </p>
      </div>

      {loading ? (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-600"></div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {profile?.role === 'admin' || profile?.role === 'faculty' ? (
              <>
                <StatCard
                  title="Total Students"
                  value={stats?.students || 0}
                  icon="👥"
                  color="from-blue-400 to-blue-600"
                  delay={0}
                />
                <StatCard
                  title="Total Courses"
                  value={stats?.courses || 0}
                  icon="📚"
                  color="from-purple-400 to-purple-600"
                  delay={100}
                />
                <StatCard
                  title="Active Semesters"
                  value={stats?.activeSemesters || 0}
                  icon="📆"
                  color="from-green-400 to-green-600"
                  delay={200}
                />
                <StatCard
                  title="Enrollments"
                  value={stats?.enrollments || 0}
                  icon="📝"
                  color="from-orange-400 to-orange-600"
                  delay={300}
                />
              </>
            ) : (
              <>
                <StatCard
                  title="My Courses"
                  value={stats?.enrollments || 0}
                  icon="🎓"
                  color="from-blue-400 to-blue-600"
                />
                <StatCard
                  title="My Grades"
                  value={stats?.grades || 0}
                  icon="📊"
                  color="from-purple-400 to-purple-600"
                />
                <StatCard
                  title="Attendance Records"
                  value={stats?.attendance || 0}
                  icon="✅"
                  color="from-green-400 to-green-600"
                />
              </>
            )}
          </div>

          {profile?.role === 'admin' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white rounded-xl shadow-lg p-6">
                <h2 className="text-xl font-bold mb-4">Statistics Overview</h2>
                <canvas ref={setChartRef}></canvas>
              </div>
              <div className="bg-white rounded-xl shadow-lg p-6">
                <h2 className="text-xl font-bold mb-4">Recent Courses</h2>
                <div className="space-y-3">
                  {recentCourses.length > 0 ? (
                    recentCourses.map((course) => (
                      <div
                        key={course.id}
                        className="p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                      >
                        <div className="font-semibold">{course.code}</div>
                        <div className="text-sm text-gray-600">{course.name}</div>
                      </div>
                    ))
                  ) : (
                    <p className="text-gray-500">No courses yet</p>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Continue with other pages... (Students, Courses, etc.)
// Due to length, I'll create a comprehensive version with all features

// Placeholder for remaining pages - will continue in next part
function StudentsPage() {
  const { supabase, user } = useAuth();
  const [students, setStudents] = React.useState([]);
  const [search, setSearch] = React.useState('');
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!supabase || !user?.id) return;
    async function load() {
      setLoading(true);
      const { data, error } = await sb(
        supabase
          .from('profiles')
          .select('id, full_name, email, role')
          .eq('role', 'student')
          .order('full_name'),
        'profiles:listStudents',
        { userId: user.id }
      );
      if (error) {
        // Keep empty list, but make sure the error is visible.
        setStudents([]);
      } else if (data) {
        setStudents(data);
      }
      setLoading(false);
    }
    load();
  }, [supabase, user?.id]);

  const filtered = students.filter(
    (s) =>
      s.full_name?.toLowerCase().includes(search.toLowerCase()) ||
      s.email?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-800">Students</h1>
          <p className="text-gray-600 mt-1">Manage student profiles and information</p>
        </div>
        <div className="bg-blue-100 text-blue-700 px-4 py-2 rounded-lg font-semibold">
          Total: {filtered.length}
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-lg p-6">
        <input
          type="text"
          placeholder="Search students by name or email..."
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent mb-4"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Name</th>
                <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Email</th>
                <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filtered.map((s) => (
                <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">{s.full_name || '—'}</td>
                  <td className="px-4 py-3">{s.email}</td>
                  <td className="px-4 py-3">
                    <span className="bg-green-100 text-green-700 px-2 py-1 rounded-full text-xs font-medium">
                      student
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Continue with all other pages...
// For brevity, I'll add key pages. Full implementation continues below.

function CoursesPage() {
  const { supabase, profile, user } = useAuth();
  const [courses, setCourses] = React.useState([]);
  const [departments, setDepartments] = React.useState([]);
  const [search, setSearch] = React.useState('');
  const [form, setForm] = React.useState({
    code: '',
    name: '',
    department_id: '',
    description: '',
    credits: 3,
  });
  const [creating, setCreating] = React.useState(false);

  React.useEffect(() => {
    if (!supabase || !user?.id) return;
    async function load() {
      const [{ data: coursesData, error: coursesErr }, { data: deptData, error: deptErr }] = await Promise.all([
        sb(supabase.from('courses').select('*').order('code'), 'courses:list', { userId: user.id }),
        sb(supabase.from('departments').select('id, name, code').order('name'), 'departments:listForCourses', {
          userId: user.id,
        }),
      ]);

      if (coursesErr) setCourses([]);
      else if (coursesData) setCourses(coursesData);

      if (deptErr) setDepartments([]);
      else if (deptData) setDepartments(deptData);
    }
    load();
  }, [supabase, user?.id]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!supabase || !user?.id) {
      console.error('[courses] insert attempted without session', { userId: user?.id });
      alert('Not signed in yet. Please wait a moment and try again.');
      return;
    }

    setCreating(true);

    // NOTE: If your DB schema uses a column like `user_id` / `created_by`, add it here.
    // We always include at least one authenticated identifier in logs to debug RLS.
    if (!form.department_id) {
      alert('Please select a department (department_id is required by your database).');
      setCreating(false);
      return;
    }

    const payload = {
      code: form.code,
      name: form.name,
      description: form.description,
      credits: form.credits,
      department_id: form.department_id,
      // Most schemas model the instructor as a user/profile id.
      faculty_id: profile?.role === 'faculty' ? user.id : profile?.id || null,
    };

    const { error } = await sb(supabase.from('courses').insert(payload), 'courses:insert', {
      userId: user.id,
      payload,
    });

    if (error) {
      alert(
        `Failed to add course: ${error.message || String(error)}\n` +
          (error.code ? `code: ${error.code}\n` : '') +
          (error.details ? `details: ${error.details}\n` : '') +
          (error.hint ? `hint: ${error.hint}\n` : '')
      );
    } else {
      setForm({ code: '', name: '', department_id: '', description: '', credits: 3 });
      const { data } = await sb(supabase.from('courses').select('*').order('code'), 'courses:listAfterInsert', {
        userId: user.id,
      });
      if (data) setCourses(data);
    }

    setCreating(false);
  };

  const filtered = courses.filter(
    (c) =>
      c.code?.toLowerCase().includes(search.toLowerCase()) ||
      c.name?.toLowerCase().includes(search.toLowerCase()) ||
      c.description?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-800">Courses</h1>
          <p className="text-gray-600 mt-1">Manage academic courses</p>
        </div>
        <div className="bg-purple-100 text-purple-700 px-4 py-2 rounded-lg font-semibold">
          Total: {filtered.length}
        </div>
      </div>

      {(profile?.role === 'admin' || profile?.role === 'faculty') && (
        <div className="bg-white rounded-xl shadow-lg p-6">
          <h2 className="text-xl font-bold mb-4">Create New Course</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Code</label>
                <input
                  className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input
                  className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Department</label>
                <select
                  className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                  value={form.department_id}
                  onChange={(e) => setForm({ ...form, department_id: e.target.value })}
                  required
                >
                  <option value="">Select department</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.code ? `${d.code} - ` : ''}{d.name}
                    </option>
                  ))}
                </select>
                {departments.length === 0 && (
                  <div className="text-xs text-gray-500 mt-1">
                    No departments found. Create one in the Departments page first.
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Credits</label>
                <input
                  type="number"
                  className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                  value={form.credits}
                  onChange={(e) => setForm({ ...form, credits: Number(e.target.value) || 3 })}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <textarea
                className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                rows="2"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <button
              type="submit"
              className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
              disabled={creating}
            >
              {creating ? 'Creating...' : 'Add Course'}
            </button>
          </form>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-lg p-6">
        <input
          type="text"
          placeholder="Search courses..."
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 mb-4"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left">Code</th>
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Credits</th>
                <th className="px-4 py-3 text-left">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filtered.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-semibold">{c.code}</td>
                  <td className="px-4 py-3">{c.name}</td>
                  <td className="px-4 py-3">{c.credits}</td>
                  <td className="px-4 py-3 text-gray-600">{c.description || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Add remaining essential pages - My Courses, Enrollments, Attendance, Grades, Departments, Semesters, Profile, etc.
// Due to message length limits, I'll create a continuation file or add key pages here

// My Courses Page (Student)
function MyCoursesPage() {
  const { supabase, profile } = useAuth();
  const [enrollments, setEnrollments] = React.useState([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!supabase || !profile) return;
    async function load() {
      setLoading(true);
      const { data } = await supabase
        .from('enrollments')
        .select(
          `
          *,
          course:courses(*),
          semester:semesters(*)
        `
        )
        .eq('student_id', profile.id);
      if (data) setEnrollments(data);
      setLoading(false);
    }
    load();
  }, [supabase, profile]);

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <h1 className="text-3xl font-bold text-gray-800">My Courses</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {enrollments.map((e) => (
          <div
            key={e.id}
            className="bg-white rounded-xl shadow-lg p-6 hover:shadow-xl transition-shadow transform hover:scale-105"
          >
            <div className="text-2xl font-bold text-blue-600 mb-2">{e.course?.code}</div>
            <div className="text-lg font-semibold mb-2">{e.course?.name}</div>
            <div className="text-sm text-gray-600 mb-4">{e.semester?.name}</div>
            <div className="flex items-center gap-2">
              <span className="bg-blue-100 text-blue-700 px-2 py-1 rounded text-xs">
                {e.course?.credits} credits
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Course Catalog (Student)
function CourseCatalogPage() {
  const { supabase, user } = useAuth();
  const [courses, setCourses] = React.useState([]);
  const [search, setSearch] = React.useState('');

  React.useEffect(() => {
    if (!supabase || !user?.id) return;
    async function load() {
      const { data, error } = await sb(supabase.from('courses').select('*').order('code'), 'courses:listCatalog', {
        userId: user.id,
      });
      if (error) setCourses([]);
      else if (data) setCourses(data);
    }
    load();
  }, [supabase, user?.id]);

  const filtered = courses.filter(
    (c) =>
      c.code?.toLowerCase().includes(search.toLowerCase()) ||
      c.name?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <h1 className="text-3xl font-bold text-gray-800">Course Catalog</h1>
      <input
        type="text"
        placeholder="Search courses..."
        className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filtered.map((c) => (
          <div
            key={c.id}
            className="bg-white rounded-xl shadow-lg p-6 hover:shadow-xl transition-all transform hover:scale-105"
          >
            <div className="text-xl font-bold text-blue-600 mb-2">{c.code}</div>
            <div className="text-lg font-semibold mb-2">{c.name}</div>
            <div className="text-sm text-gray-600 mb-4">{c.description || 'No description'}</div>
            <div className="flex items-center gap-2">
              <span className="bg-purple-100 text-purple-700 px-2 py-1 rounded text-xs">
                {c.credits} credits
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Enrollments Page (Admin)
function EnrollmentsPage() {
  const { supabase, user } = useAuth();
  const [enrollments, setEnrollments] = React.useState([]);
  const [students, setStudents] = React.useState([]);
  const [courses, setCourses] = React.useState([]);
  const [semesters, setSemesters] = React.useState([]);
  const [form, setForm] = React.useState({ student_id: '', course_id: '', semester_id: '' });

  const reload = React.useCallback(async () => {
    if (!supabase || !user?.id) return;
    const [enrolls, studs, cors, sems] = await Promise.all([
      sb(
        supabase
          .from('enrollments')
          .select('*, student:profiles(*), course:courses(*), semester:semesters(*)'),
        'enrollments:list',
        { userId: user.id }
      ),
      sb(supabase.from('profiles').select('*').eq('role', 'student'), 'profiles:listStudentsForEnrollments', {
        userId: user.id,
      }),
      sb(supabase.from('courses').select('*'), 'courses:listForEnrollments', { userId: user.id }),
      sb(supabase.from('semesters').select('*'), 'semesters:listForEnrollments', { userId: user.id }),
    ]);

    if (!enrolls.error && enrolls.data) setEnrollments(enrolls.data);
    else setEnrollments([]);

    if (!studs.error && studs.data) setStudents(studs.data);
    else setStudents([]);

    if (!cors.error && cors.data) setCourses(cors.data);
    else setCourses([]);

    if (!sems.error && sems.data) setSemesters(sems.data);
    else setSemesters([]);
  }, [supabase, user?.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const handleEnroll = async (e) => {
    e.preventDefault();
    if (!supabase || !user?.id) return;

    const { error } = await sb(supabase.from('enrollments').insert(form), 'enrollments:insert', {
      userId: user.id,
      form,
    });

    if (error) {
      alert(
        `Failed to enroll: ${error.message || String(error)}\n` +
          (error.code ? `code: ${error.code}\n` : '') +
          (error.details ? `details: ${error.details}\n` : '') +
          (error.hint ? `hint: ${error.hint}\n` : '')
      );
      return;
    }

    setForm({ student_id: '', course_id: '', semester_id: '' });
    await reload();
  };

  const handleRemove = async (id) => {
    if (!supabase || !user?.id) return;

    const { error } = await sb(supabase.from('enrollments').delete().eq('id', id), 'enrollments:delete', {
      userId: user.id,
      enrollmentId: id,
    });

    if (error) {
      alert(
        `Failed to remove enrollment: ${error.message || String(error)}\n` +
          (error.code ? `code: ${error.code}\n` : '') +
          (error.details ? `details: ${error.details}\n` : '') +
          (error.hint ? `hint: ${error.hint}\n` : '')
      );
      return;
    }

    await reload();
  };

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <h1 className="text-3xl font-bold text-gray-800">Enrollments</h1>
      <div className="bg-white rounded-xl shadow-lg p-6">
        <h2 className="text-xl font-bold mb-4">Enroll Student</h2>
        <form onSubmit={handleEnroll} className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <select
            className="px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
            value={form.student_id}
            onChange={(e) => setForm({ ...form, student_id: e.target.value })}
            required
          >
            <option value="">Select Student</option>
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.full_name || s.email}
              </option>
            ))}
          </select>
          <select
            className="px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
            value={form.course_id}
            onChange={(e) => setForm({ ...form, course_id: e.target.value })}
            required
          >
            <option value="">Select Course</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} - {c.name}
              </option>
            ))}
          </select>
          <select
            className="px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
            value={form.semester_id}
            onChange={(e) => setForm({ ...form, semester_id: e.target.value })}
            required
          >
            <option value="">Select Semester</option>
            {semesters.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Enroll
          </button>
        </form>
      </div>
      <div className="bg-white rounded-xl shadow-lg p-6">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left">Student</th>
                <th className="px-4 py-3 text-left">Course</th>
                <th className="px-4 py-3 text-left">Semester</th>
                <th className="px-4 py-3 text-left">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {enrollments.map((e) => (
                <tr key={e.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">{e.student?.full_name || e.student?.email}</td>
                  <td className="px-4 py-3">
                    {e.course?.code} - {e.course?.name}
                  </td>
                  <td className="px-4 py-3">{e.semester?.name}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleRemove(e.id)}
                      className="text-red-600 hover:text-red-700 font-medium"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Attendance Page (Admin/Faculty)
function AttendancePage() {
  const { supabase, profile, user } = useAuth();
  const [courses, setCourses] = React.useState([]);
  const [selectedCourse, setSelectedCourse] = React.useState('');
  const [sessionDate, setSessionDate] = React.useState(new Date().toISOString().split('T')[0]);
  const [students, setStudents] = React.useState([]);
  const [attendance, setAttendance] = React.useState({});
  const [sessionId, setSessionId] = React.useState(null);

  React.useEffect(() => {
    if (!supabase || !user?.id) return;
    async function load() {
      const query = supabase.from('courses').select('*');
      if (profile?.role === 'faculty') {
        query.eq('faculty_id', profile.id);
      }
      const { data, error } = await sb(query, 'courses:listForAttendance', {
        userId: user.id,
        role: profile?.role,
      });
      if (error) setCourses([]);
      else if (data) setCourses(data);
    }
    load();
  }, [supabase, profile, user?.id]);

  const loadSession = async () => {
    if (!supabase || !user?.id) return;
    if (!selectedCourse || !sessionDate) return;

    const { data: session, error: sessionErr } = await sb(
      supabase
        .from('class_sessions')
        .select('id')
        .eq('course_id', selectedCourse)
        .eq('session_date', sessionDate)
        .single(),
      'class_sessions:getByCourseAndDate',
      { userId: user.id, courseId: selectedCourse, sessionDate }
    );

    let sid = session?.id;
    if (!sid && !sessionErr) {
      const { data: newSession, error: newSessionErr } = await sb(
        supabase
          .from('class_sessions')
          .insert({ course_id: selectedCourse, session_date: sessionDate })
          .select()
          .single(),
        'class_sessions:insert',
        { userId: user.id, courseId: selectedCourse, sessionDate }
      );
      if (newSessionErr) {
        alert(
          `Failed to create class session: ${newSessionErr.message || String(newSessionErr)}\n` +
            (newSessionErr.code ? `code: ${newSessionErr.code}\n` : '') +
            (newSessionErr.details ? `details: ${newSessionErr.details}\n` : '') +
            (newSessionErr.hint ? `hint: ${newSessionErr.hint}\n` : '')
        );
        return;
      }
      sid = newSession?.id;
    }

    if (!sid) return;
    setSessionId(sid);

    const { data: enrolls, error: enrollErr } = await sb(
      supabase.from('enrollments').select('student:profiles(*)').eq('course_id', selectedCourse),
      'enrollments:listStudentsForCourseSession',
      { userId: user.id, courseId: selectedCourse, sessionId: sid }
    );

    if (enrollErr || !enrolls) {
      setStudents([]);
      setAttendance({});
      return;
    }

    const studs = enrolls.map((e) => e.student).filter(Boolean);
    setStudents(studs);

    const { data: att } = await sb(
      supabase.from('attendance').select('*').eq('session_id', sid),
      'attendance:listForSession',
      { userId: user.id, sessionId: sid }
    );

    const attMap = {};
    att?.forEach((a) => {
      attMap[a.student_id] = a.status;
    });
    setAttendance(attMap);
  };

  const saveAttendance = async () => {
    if (!supabase || !user?.id) return;
    if (!sessionId) return;

    const records = Object.entries(attendance).map(([student_id, status]) => ({
      session_id: sessionId,
      student_id,
      status,
    }));

    const { error } = await sb(
      supabase.from('attendance').upsert(records, { onConflict: 'session_id,student_id' }),
      'attendance:upsert',
      { userId: user.id, sessionId, recordsCount: records.length }
    );

    if (error) {
      alert(
        `Failed to save attendance: ${error.message || String(error)}\n` +
          (error.code ? `code: ${error.code}\n` : '') +
          (error.details ? `details: ${error.details}\n` : '') +
          (error.hint ? `hint: ${error.hint}\n` : '')
      );
      return;
    }

    alert('Attendance saved!');
  };

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <h1 className="text-3xl font-bold text-gray-800">Attendance</h1>
      <div className="bg-white rounded-xl shadow-lg p-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <select
            className="px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
            value={selectedCourse}
            onChange={(e) => setSelectedCourse(e.target.value)}
          >
            <option value="">Select Course</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} - {c.name}
              </option>
            ))}
          </select>
          <input
            type="date"
            className="px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
            value={sessionDate}
            onChange={(e) => setSessionDate(e.target.value)}
          />
          <button
            onClick={loadSession}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Load Session
          </button>
        </div>
        {students.length > 0 && (
          <>
            <div className="space-y-2 mb-4">
              {students.map((s) => (
                <div key={s.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div>
                    <div className="font-semibold">{s.full_name || s.email}</div>
                  </div>
                  <select
                    className="px-3 py-1 border rounded-lg"
                    value={attendance[s.id] || 'absent'}
                    onChange={(e) => setAttendance({ ...attendance, [s.id]: e.target.value })}
                  >
                    <option value="present">Present</option>
                    <option value="absent">Absent</option>
                    <option value="late">Late</option>
                  </select>
                </div>
              ))}
            </div>
            <button
              onClick={saveAttendance}
              className="w-full bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors"
            >
              Save Attendance
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// My Attendance (Student)
function MyAttendancePage() {
  const { supabase, profile, user } = useAuth();
  const [attendance, setAttendance] = React.useState([]);

  React.useEffect(() => {
    if (!supabase || !profile || !user?.id) return;
    async function load() {
      const { data, error } = await sb(
        supabase
          .from('attendance')
          .select(
            `
          *,
          session:class_sessions(*, course:courses(*))
        `
          )
          .eq('student_id', profile.id)
          .order('marked_at', { ascending: false })
          .limit(50),
        'attendance:listForStudent',
        { userId: user.id, studentId: profile.id }
      );
      if (error) setAttendance([]);
      else if (data) setAttendance(data);
    }
    load();
  }, [supabase, profile, user?.id]);

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <h1 className="text-3xl font-bold text-gray-800">My Attendance</h1>
      <div className="bg-white rounded-xl shadow-lg p-6">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left">Course</th>
                <th className="px-4 py-3 text-left">Date</th>
                <th className="px-4 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {attendance.map((a) => (
                <tr key={a.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    {a.session?.course?.code} - {a.session?.course?.name}
                  </td>
                  <td className="px-4 py-3">{a.session?.session_date}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-1 rounded text-xs font-medium ${
                        a.status === 'present'
                          ? 'bg-green-100 text-green-700'
                          : a.status === 'late'
                          ? 'bg-yellow-100 text-yellow-700'
                          : 'bg-red-100 text-red-700'
                      }`}
                    >
                      {a.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Grades Page (Admin/Faculty)
function GradesPage() {
  const { supabase, profile, user } = useAuth();
  const [courses, setCourses] = React.useState([]);
  const [selectedCourse, setSelectedCourse] = React.useState('');
  const [assignments, setAssignments] = React.useState([]);
  const [form, setForm] = React.useState({ title: '', due_date: '', max_marks: 100 });

  React.useEffect(() => {
    if (!supabase || !user?.id) return;
    async function load() {
      const query = supabase.from('courses').select('*');
      if (profile?.role === 'faculty') {
        query.eq('faculty_id', profile.id);
      }
      const { data, error } = await sb(query, 'courses:listForGrades', {
        userId: user.id,
        role: profile?.role,
      });
      if (error) setCourses([]);
      else if (data) setCourses(data);
    }
    load();
  }, [supabase, profile, user?.id]);

  const loadAssignments = React.useCallback(async () => {
    if (!supabase || !user?.id) return;
    if (!selectedCourse) return;
    const { data, error } = await sb(
      supabase.from('assignments').select('*').eq('course_id', selectedCourse).order('due_date'),
      'assignments:listForCourse',
      { userId: user.id, courseId: selectedCourse }
    );
    if (error) setAssignments([]);
    else if (data) setAssignments(data);
  }, [supabase, user?.id, selectedCourse]);

  React.useEffect(() => {
    loadAssignments();
  }, [loadAssignments]);

  const handleCreateAssignment = async (e) => {
    e.preventDefault();
    if (!supabase || !user?.id) return;

    const payload = { ...form, course_id: selectedCourse };
    const { error } = await sb(supabase.from('assignments').insert(payload), 'assignments:insert', {
      userId: user.id,
      payload,
    });

    if (error) {
      alert(
        `Failed to create assignment: ${error.message || String(error)}\n` +
          (error.code ? `code: ${error.code}\n` : '') +
          (error.details ? `details: ${error.details}\n` : '') +
          (error.hint ? `hint: ${error.hint}\n` : '')
      );
      return;
    }

    setForm({ title: '', due_date: '', max_marks: 100 });
    loadAssignments();
  };

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <h1 className="text-3xl font-bold text-gray-800">Grades & Assignments</h1>
      <div className="bg-white rounded-xl shadow-lg p-6">
        <select
          className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 mb-4"
          value={selectedCourse}
          onChange={(e) => setSelectedCourse(e.target.value)}
        >
          <option value="">Select Course</option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} - {c.name}
            </option>
          ))}
        </select>
        {selectedCourse && (
          <>
            <h2 className="text-xl font-bold mb-4">Create Assignment</h2>
            <form onSubmit={handleCreateAssignment} className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <input
                className="px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="Title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                required
              />
              <input
                type="date"
                className="px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                value={form.due_date}
                onChange={(e) => setForm({ ...form, due_date: e.target.value })}
              />
              <div className="flex gap-2">
                <input
                  type="number"
                  className="flex-1 px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                  placeholder="Max Marks"
                  value={form.max_marks}
                  onChange={(e) => setForm({ ...form, max_marks: Number(e.target.value) || 100 })}
                />
                <button
                  type="submit"
                  className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Create
                </button>
              </div>
            </form>
            <div className="space-y-2">
              {assignments.map((a) => (
                <div key={a.id} className="p-4 bg-gray-50 rounded-lg flex items-center justify-between">
                  <div>
                    <div className="font-semibold">{a.title}</div>
                    <div className="text-sm text-gray-600">
                      Due: {a.due_date} | Max: {a.max_marks}
                    </div>
                  </div>
                  <GradeAssignmentButton assignmentId={a.id} courseId={selectedCourse} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function GradeAssignmentButton({ assignmentId, courseId }) {
  const { supabase, user } = useAuth();
  const [open, setOpen] = React.useState(false);
  const [students, setStudents] = React.useState([]);
  const [grades, setGrades] = React.useState({});

  const loadData = async () => {
    if (!supabase || !user?.id) return;

    const { data: enrolls, error: enrollErr } = await sb(
      supabase.from('enrollments').select('student:profiles(*)').eq('course_id', courseId),
      'enrollments:listForGradeAssignmentModal',
      { userId: user.id, courseId, assignmentId }
    );

    if (enrollErr || !enrolls) {
      setStudents([]);
      setGrades({});
      return;
    }

    const studs = enrolls.map((e) => e.student).filter(Boolean);
    setStudents(studs);

    const { data: gs } = await sb(
      supabase.from('grades').select('*').eq('assignment_id', assignmentId),
      'grades:listForAssignment',
      { userId: user.id, assignmentId }
    );

    const gradeMap = {};
    gs?.forEach((g) => {
      gradeMap[g.student_id] = g.marks_obtained;
    });
    setGrades(gradeMap);
  };

  React.useEffect(() => {
    if (open) loadData();
  }, [open]);

  const saveGrades = async () => {
    if (!supabase || !user?.id) return;

    const records = Object.entries(grades).map(([student_id, marks_obtained]) => ({
      assignment_id: assignmentId,
      student_id,
      marks_obtained: Number(marks_obtained) || 0,
    }));

    const { error } = await sb(supabase.from('grades').upsert(records, { onConflict: 'assignment_id,student_id' }), 'grades:upsertForAssignment', {
      userId: user.id,
      assignmentId,
      recordsCount: records.length,
    });

    if (error) {
      alert(
        `Failed to save grades: ${error.message || String(error)}\n` +
          (error.code ? `code: ${error.code}\n` : '') +
          (error.details ? `details: ${error.details}\n` : '') +
          (error.hint ? `hint: ${error.hint}\n` : '')
      );
      return;
    }

    alert('Grades saved!');
    setOpen(false);
  };

  if (!open)
    return (
      <button
        onClick={() => setOpen(true)}
        className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors"
      >
        Grade
      </button>
    );

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-bold">Enter Grades</h3>
          <button onClick={() => setOpen(false)} className="text-gray-500 hover:text-gray-700">
            ✕
          </button>
        </div>
        <div className="space-y-2 mb-4">
          {students.map((s) => (
            <div key={s.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <div className="font-semibold">{s.full_name || s.email}</div>
              <input
                type="number"
                className="w-24 px-3 py-1 border rounded-lg"
                placeholder="Marks"
                value={grades[s.id] || ''}
                onChange={(e) => setGrades({ ...grades, [s.id]: e.target.value })}
              />
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            onClick={saveGrades}
            className="flex-1 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors"
          >
            Save Grades
          </button>
          <button
            onClick={() => setOpen(false)}
            className="px-4 py-2 border rounded-lg hover:bg-gray-100 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// My Grades (Student)
function MyGradesPage() {
  const { supabase, profile, user } = useAuth();
  const [grades, setGrades] = React.useState([]);

  React.useEffect(() => {
    if (!supabase || !profile || !user?.id) return;
    async function load() {
      const { data, error } = await sb(
        supabase
          .from('grades')
          .select(
            `
          *,
          assignment:assignments(*, course:courses(*))
        `
          )
          .eq('student_id', profile.id)
          .order('graded_at', { ascending: false }),
        'grades:listForStudent',
        { userId: user.id, studentId: profile.id }
      );
      if (error) setGrades([]);
      else if (data) setGrades(data);
    }
    load();
  }, [supabase, profile, user?.id]);

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <h1 className="text-3xl font-bold text-gray-800">My Grades</h1>
      <div className="bg-white rounded-xl shadow-lg p-6">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left">Course</th>
                <th className="px-4 py-3 text-left">Assignment</th>
                <th className="px-4 py-3 text-left">Marks Obtained</th>
                <th className="px-4 py-3 text-left">Max Marks</th>
                <th className="px-4 py-3 text-left">Percentage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {grades.map((g) => (
                <tr key={g.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    {g.assignment?.course?.code} - {g.assignment?.course?.name}
                  </td>
                  <td className="px-4 py-3">{g.assignment?.title}</td>
                  <td className="px-4 py-3 font-semibold">{g.marks_obtained}</td>
                  <td className="px-4 py-3">{g.assignment?.max_marks}</td>
                  <td className="px-4 py-3">
                    {g.assignment?.max_marks
                      ? Math.round((g.marks_obtained / g.assignment.max_marks) * 100)
                      : 0}
                    %
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Departments Page (Admin)
function DepartmentsPage() {
  const { supabase, user } = useAuth();
  const [departments, setDepartments] = React.useState([]);
  const [form, setForm] = React.useState({ name: '', code: '' });
  const [creating, setCreating] = React.useState(false);

  const reload = React.useCallback(async () => {
    if (!supabase || !user?.id) return;
    const { data, error } = await sb(supabase.from('departments').select('*').order('name'), 'departments:list', {
      userId: user.id,
    });
    if (error) setDepartments([]);
    else if (data) setDepartments(data);
  }, [supabase, user?.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!supabase || !user?.id) return;

    setCreating(true);
    const { error } = await sb(supabase.from('departments').insert(form), 'departments:insert', {
      userId: user.id,
      form,
    });

    if (error) {
      alert(
        `Failed to add department: ${error.message || String(error)}\n` +
          (error.code ? `code: ${error.code}\n` : '') +
          (error.details ? `details: ${error.details}\n` : '') +
          (error.hint ? `hint: ${error.hint}\n` : '')
      );
    } else {
      setForm({ name: '', code: '' });
      await reload();
    }

    setCreating(false);
  };

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <h1 className="text-3xl font-bold text-gray-800">Departments</h1>
      <div className="bg-white rounded-xl shadow-lg p-6">
        <h2 className="text-xl font-bold mb-4">Create Department</h2>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <input
            className="px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <input
            className="px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
            placeholder="Code"
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
            required
          />
          <button
            type="submit"
            className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
            disabled={creating}
          >
            {creating ? 'Creating...' : 'Add Department'}
          </button>
        </form>
      </div>
      <div className="bg-white rounded-xl shadow-lg p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {departments.map((d) => (
            <div
              key={d.id}
              className="p-4 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg border border-blue-200"
            >
              <div className="text-lg font-bold text-blue-700">{d.code}</div>
              <div className="text-gray-700">{d.name}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Semesters Page (Admin)
function SemestersPage() {
  const { supabase, user } = useAuth();
  const [semesters, setSemesters] = React.useState([]);
  const [form, setForm] = React.useState({
    name: '',
    start_date: '',
    end_date: '',
    is_active: true,
  });
  const [creating, setCreating] = React.useState(false);

  const reload = React.useCallback(async () => {
    if (!supabase || !user?.id) return;
    const { data, error } = await sb(
      supabase.from('semesters').select('*').order('start_date', { ascending: false }),
      'semesters:list',
      { userId: user.id }
    );
    if (error) setSemesters([]);
    else if (data) setSemesters(data);
  }, [supabase, user?.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!supabase || !user?.id) return;

    setCreating(true);
    const { error } = await sb(supabase.from('semesters').insert(form), 'semesters:insert', {
      userId: user.id,
      form,
    });

    if (error) {
      alert(
        `Failed to add semester: ${error.message || String(error)}\n` +
          (error.code ? `code: ${error.code}\n` : '') +
          (error.details ? `details: ${error.details}\n` : '') +
          (error.hint ? `hint: ${error.hint}\n` : '')
      );
    } else {
      setForm({ name: '', start_date: '', end_date: '', is_active: true });
      await reload();
    }

    setCreating(false);
  };

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <h1 className="text-3xl font-bold text-gray-800">Semesters</h1>
      <div className="bg-white rounded-xl shadow-lg p-6">
        <h2 className="text-xl font-bold mb-4">Create Semester</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <input
              className="px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="Name (e.g., Fall 2024)"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
            <input
              type="date"
              className="px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
              value={form.start_date}
              onChange={(e) => setForm({ ...form, start_date: e.target.value })}
              required
            />
            <input
              type="date"
              className="px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
              value={form.end_date}
              onChange={(e) => setForm({ ...form, end_date: e.target.value })}
              required
            />
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
              />
              <span>Active</span>
            </label>
          </div>
          <button
            type="submit"
            className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
            disabled={creating}
          >
            {creating ? 'Creating...' : 'Add Semester'}
          </button>
        </form>
      </div>
      <div className="bg-white rounded-xl shadow-lg p-6">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Start Date</th>
                <th className="px-4 py-3 text-left">End Date</th>
                <th className="px-4 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {semesters.map((s) => (
                <tr key={s.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-semibold">{s.name}</td>
                  <td className="px-4 py-3">{s.start_date}</td>
                  <td className="px-4 py-3">{s.end_date}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-1 rounded text-xs font-medium ${
                        s.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {s.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Analytics Page (Admin)
function AnalyticsPage() {
  const { supabase, user } = useAuth();
  const [stats, setStats] = React.useState(null);
  const [chartRef, setChartRef] = React.useState(null);

  React.useEffect(() => {
    if (!supabase || !user?.id) return;
    async function load() {
      const [students, courses, enrollments, grades] = await Promise.all([
        sb(
          supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'student'),
          'profiles:countStudentsForAnalytics',
          { userId: user.id }
        ),
        sb(supabase.from('courses').select('id', { count: 'exact', head: true }), 'courses:countForAnalytics', {
          userId: user.id,
        }),
        sb(
          supabase.from('enrollments').select('id', { count: 'exact', head: true }),
          'enrollments:countForAnalytics',
          { userId: user.id }
        ),
        sb(supabase.from('grades').select('id', { count: 'exact', head: true }), 'grades:countForAnalytics', {
          userId: user.id,
        }),
      ]);
      setStats({
        students: students.count || 0,
        courses: courses.count || 0,
        enrollments: enrollments.count || 0,
        grades: grades.count || 0,
      });
    }
    load();
  }, [supabase, user?.id]);

  React.useEffect(() => {
    if (!chartRef || !stats) return;
    const ctx = chartRef.getContext('2d');
    const chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['Students', 'Courses', 'Enrollments', 'Grades'],
        datasets: [
          {
            label: 'Count',
            data: [stats.students, stats.courses, stats.enrollments, stats.grades],
            backgroundColor: ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b'],
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
        },
      },
    });
    return () => chart.destroy();
  }, [chartRef, stats]);

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <h1 className="text-3xl font-bold text-gray-800">Analytics Dashboard</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl p-6 text-white shadow-lg">
          <div className="text-3xl font-bold">{stats?.students || 0}</div>
          <div className="text-blue-100">Total Students</div>
        </div>
        <div className="bg-gradient-to-br from-purple-500 to-purple-600 rounded-xl p-6 text-white shadow-lg">
          <div className="text-3xl font-bold">{stats?.courses || 0}</div>
          <div className="text-purple-100">Total Courses</div>
        </div>
        <div className="bg-gradient-to-br from-green-500 to-green-600 rounded-xl p-6 text-white shadow-lg">
          <div className="text-3xl font-bold">{stats?.enrollments || 0}</div>
          <div className="text-green-100">Enrollments</div>
        </div>
        <div className="bg-gradient-to-br from-orange-500 to-orange-600 rounded-xl p-6 text-white shadow-lg">
          <div className="text-3xl font-bold">{stats?.grades || 0}</div>
          <div className="text-orange-100">Grades Recorded</div>
        </div>
      </div>
      <div className="bg-white rounded-xl shadow-lg p-6">
        <h2 className="text-xl font-bold mb-4">Statistics Chart</h2>
        <canvas ref={setChartRef}></canvas>
      </div>
    </div>
  );
}

// Reports Page (Admin)
function ReportsPage() {
  const { supabase, user, profile } = useAuth();

  const REPORT_DEFS = React.useMemo(
    () => [
      {
        id: 'students',
        label: 'Students',
        async fetch() {
          return sb(
            supabase
              .from('profiles')
              .select('id, full_name, email, role')
              .eq('role', 'student')
              .order('full_name'),
            'reports:students',
            { userId: user?.id }
          );
        },
        columns: [
          { key: 'full_name', label: 'Name' },
          { key: 'email', label: 'Email' },
        ],
        flatten(rows) {
          return (rows || []).map((r) => ({
            name: r.full_name || '',
            email: r.email || '',
          }));
        },
      },
      {
        id: 'courses',
        label: 'Courses',
        async fetch() {
          return sb(
            supabase
              .from('courses')
              .select('id, code, name, credits, description, department:departments(code, name), faculty_id')
              .order('code'),
            'reports:courses',
            { userId: user?.id }
          );
        },
        columns: [
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Name' },
          { key: 'credits', label: 'Credits' },
          { key: 'department', label: 'Department' },
        ],
        flatten(rows) {
          return (rows || []).map((r) => ({
            code: r.code || '',
            name: r.name || '',
            credits: r.credits ?? '',
            department: r.department?.code
              ? `${r.department.code} - ${r.department.name || ''}`
              : r.department?.name || '',
            description: r.description || '',
            faculty_id: r.faculty_id || '',
          }));
        },
      },
      {
        id: 'enrollments',
        label: 'Enrollments',
        async fetch() {
          return sb(
            supabase
              .from('enrollments')
              .select('id, student:profiles(full_name, email), course:courses(code, name), semester:semesters(name)')
              .order('created_at', { ascending: false }),
            'reports:enrollments',
            { userId: user?.id }
          );
        },
        columns: [
          { key: 'student', label: 'Student' },
          { key: 'course', label: 'Course' },
          { key: 'semester', label: 'Semester' },
        ],
        flatten(rows) {
          return (rows || []).map((r) => ({
            student: r.student?.full_name || r.student?.email || '',
            course: r.course?.code ? `${r.course.code} - ${r.course.name || ''}` : r.course?.name || '',
            semester: r.semester?.name || '',
          }));
        },
      },
    ],
    [supabase, user?.id]
  );

  const [reportId, setReportId] = React.useState('courses');
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(false);

  const selectedReport = REPORT_DEFS.find((r) => r.id === reportId) || REPORT_DEFS[0];

  const escapeCsv = (value) => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (/[\n\r,"]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const downloadText = (filename, text, mime = 'text/plain') => {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const exportCsv = () => {
    const flat = selectedReport.flatten(rows);
    if (!flat.length) {
      alert('Nothing to export.');
      return;
    }

    const headers = Object.keys(flat[0]);
    const csv = [headers.map(escapeCsv).join(',')]
      .concat(flat.map((r) => headers.map((h) => escapeCsv(r[h])).join(',')))
      .join('\n');

    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(`report_${selectedReport.id}_${stamp}.csv`, csv, 'text/csv');
  };

  const exportPdfViaPrint = () => {
    const flat = selectedReport.flatten(rows);
    const stamp = new Date().toISOString().slice(0, 10);

    const headers = flat[0] ? Object.keys(flat[0]) : [];
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Report: ${selectedReport.label}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; padding: 24px; }
    h1 { margin: 0 0 8px; }
    .meta { color: #555; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; }
  </style>
</head>
<body>
  <h1>${selectedReport.label} Report</h1>
  <div class="meta">Generated: ${stamp}</div>
  ${flat.length ? `
    <table>
      <thead>
        <tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${flat
          .map((r) => `<tr>${headers.map((h) => `<td>${String(r[h] ?? '')}</td>`).join('')}</tr>`)
          .join('')}
      </tbody>
    </table>
  ` : '<div>No data.</div>'}
</body>
</html>
`;

    const w = window.open('', '_blank');
    if (!w) {
      alert('Popup blocked. Please allow popups to export PDF.');
      return;
    }

    w.document.open();
    w.document.write(html);
    w.document.close();

    // Let the new window paint before printing.
    setTimeout(() => {
      w.focus();
      w.print();
    }, 250);
  };

  const load = React.useCallback(async () => {
    if (!supabase || !user?.id) return;
    if (!selectedReport) return;

    setLoading(true);
    const { data, error } = await selectedReport.fetch();
    if (error) {
      setRows([]);
    } else {
      setRows(data || []);
    }
    setLoading(false);
  }, [supabase, user?.id, selectedReport?.id]);

  React.useEffect(() => {
    // Only admins should see this page in the sidebar, but guard anyway.
    if (!supabase || !user?.id) return;
    if (profile?.role !== 'admin') return;
    load();
  }, [supabase, user?.id, profile?.role, load]);

  if (profile?.role !== 'admin') {
    return (
      <div className="p-6 space-y-6 animate-fade-in">
        <h1 className="text-3xl font-bold text-gray-800">Reports</h1>
        <div className="bg-white rounded-xl shadow-lg p-6">
          <p className="text-gray-600">You do not have access to reports.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold text-gray-800">Reports</h1>
          <p className="text-gray-600 mt-1">Export data to CSV or print to PDF.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            className="px-4 py-2 rounded-lg border hover:bg-gray-50"
            onClick={load}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button className="px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700" onClick={exportCsv}>
            Export CSV
          </button>
          <button
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
            onClick={exportPdfViaPrint}
          >
            Export PDF
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-lg p-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Report Type</label>
            <select
              className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
              value={reportId}
              onChange={(e) => setReportId(e.target.value)}
            >
              {REPORT_DEFS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2 text-sm text-gray-600 flex items-end">
            PDF export uses your browser’s print dialog. Choose “Save as PDF”.
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                {selectedReport.columns.map((c) => (
                  <th key={c.key} className="px-4 py-3 text-left text-sm font-semibold text-gray-700">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {(rows || []).slice(0, 100).map((r, idx) => (
                <tr key={r.id || idx} className="hover:bg-gray-50">
                  {selectedReport.columns.map((c) => {
                    let v = r[c.key];
                    if (c.key === 'department') {
                      v = r.department?.code
                        ? `${r.department.code} - ${r.department.name || ''}`
                        : r.department?.name || '';
                    }
                    if (c.key === 'student') {
                      v = r.student?.full_name || r.student?.email || '';
                    }
                    if (c.key === 'course') {
                      v = r.course?.code ? `${r.course.code} - ${r.course.name || ''}` : r.course?.name || '';
                    }
                    if (c.key === 'semester') {
                      v = r.semester?.name || '';
                    }
                    return (
                      <td key={c.key} className="px-4 py-3 text-sm text-gray-800">
                        {v ?? '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!loading && (!rows || rows.length === 0) && (
                <tr>
                  <td className="px-4 py-8 text-center text-gray-500" colSpan={selectedReport.columns.length}>
                    No data.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {rows?.length > 100 && (
          <div className="text-xs text-gray-500">Showing first 100 rows in preview. Exports include all rows.</div>
        )}
      </div>
    </div>
  );
}

// Admin Users Page
function AdminUsersPage() {
  const { supabase, user } = useAuth();
  const [users, setUsers] = React.useState([]);
  const [search, setSearch] = React.useState('');

  const reload = React.useCallback(async () => {
    if (!supabase || !user?.id) return;
    const { data, error } = await sb(supabase.from('profiles').select('*').order('full_name'), 'profiles:listForAdminUsers', {
      userId: user.id,
    });
    if (error) setUsers([]);
    else if (data) setUsers(data);
  }, [supabase, user?.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const updateRole = async (userId, newRole) => {
    if (!supabase || !user?.id) return;

    const { error } = await sb(supabase.from('profiles').update({ role: newRole }).eq('id', userId), 'profiles:updateRole', {
      userId: user.id,
      targetUserId: userId,
      newRole,
    });

    if (error) {
      alert(
        `Failed to update role: ${error.message || String(error)}\n` +
          (error.code ? `code: ${error.code}\n` : '') +
          (error.details ? `details: ${error.details}\n` : '') +
          (error.hint ? `hint: ${error.hint}\n` : '')
      );
      return;
    }

    await reload();
  };

  const filtered = users.filter(
    (u) =>
      u.full_name?.toLowerCase().includes(search.toLowerCase()) ||
      u.email?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <h1 className="text-3xl font-bold text-gray-800">User Management</h1>
      <div className="bg-white rounded-xl shadow-lg p-6">
        <input
          type="text"
          placeholder="Search users..."
          className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 mb-4"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Email</th>
                <th className="px-4 py-3 text-left">Role</th>
                <th className="px-4 py-3 text-left">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filtered.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">{u.full_name || '—'}</td>
                  <td className="px-4 py-3">{u.email}</td>
                  <td className="px-4 py-3">
                    <select
                      className="px-3 py-1 border rounded-lg"
                      value={u.role}
                      onChange={(e) => updateRole(u.id, e.target.value)}
                    >
                      <option value="student">Student</option>
                      <option value="faculty">Faculty</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-1 rounded text-xs font-medium ${
                        u.role === 'admin'
                          ? 'bg-purple-100 text-purple-700'
                          : u.role === 'faculty'
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-green-100 text-green-700'
                      }`}
                    >
                      {u.role}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Profile Page
function ProfilePage() {
  const { profile, updateProfile } = useAuth();
  const [form, setForm] = React.useState({ full_name: profile?.full_name || '' });
  const [saving, setSaving] = React.useState(false);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    await updateProfile(form);
    setSaving(false);
    alert('Profile updated!');
  };

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <h1 className="text-3xl font-bold text-gray-800">My Profile</h1>
      <div className="bg-white rounded-xl shadow-lg p-6 max-w-2xl">
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Full Name</label>
            <input
              className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input
              className="w-full px-4 py-2 border rounded-lg bg-gray-50"
              value={profile?.email || ''}
              disabled
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Role</label>
            <input
              className="w-full px-4 py-2 border rounded-lg bg-gray-50"
              value={profile?.role || ''}
              disabled
            />
          </div>
          <button
            type="submit"
            className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ---- Root App --------------------------------------------------------------

function App() {
  const { route, navigate } = useRoute();
  const { profile, loading, signOut } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-600 mb-4"></div>
          <div className="text-gray-600">Checking session with Supabase…</div>
        </div>
      </div>
    );
  }

  if (!profile) {
    return <LoginPage />;
  }

  let content = null;
  switch (route) {
    case ROUTES.STUDENTS:
      content = <StudentsPage />;
      break;
    case ROUTES.COURSES:
      content = <CoursesPage />;
      break;
    case ROUTES.MY_COURSES:
      content = <MyCoursesPage />;
      break;
    case ROUTES.COURSE_CATALOG:
      content = <CourseCatalogPage />;
      break;
    case ROUTES.ENROLLMENTS:
      content = <EnrollmentsPage />;
      break;
    case ROUTES.ATTENDANCE:
      content = <AttendancePage />;
      break;
    case ROUTES.MY_ATTENDANCE:
      content = <MyAttendancePage />;
      break;
    case ROUTES.GRADES:
      content = <GradesPage />;
      break;
    case ROUTES.MY_GRADES:
      content = <MyGradesPage />;
      break;
    case ROUTES.DEPARTMENTS:
      content = <DepartmentsPage />;
      break;
    case ROUTES.SEMESTERS:
      content = <SemestersPage />;
      break;
    case ROUTES.ANALYTICS:
      content = <AnalyticsPage />;
      break;
    case ROUTES.REPORTS:
      content = <ReportsPage />;
      break;
    case ROUTES.ADMIN_USERS:
      content = <AdminUsersPage />;
      break;
    case ROUTES.PROFILE:
      content = <ProfilePage />;
      break;
    case ROUTES.DASHBOARD:
    default:
      content = <DashboardPage />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-blue-50 to-indigo-50 lg:flex">
      <Sidebar route={route} navigate={navigate} profile={profile} onLogout={signOut} />
      {/*
        On large screens the sidebar becomes `static`, so without a flex container it will push the main
        content *below* it (looks like the page is rendering at the bottom).
      */}
      <main className="flex-1 min-h-screen pt-16 lg:pt-0">{content}</main>
    </div>
  );
}

// ---- Render ----------------------------------------------------------------

function initApp() {
  // Wait for Supabase to be available
  if (typeof window === 'undefined' || !window.supabase) {
    console.warn('Waiting for Supabase to load...');
    setTimeout(initApp, 100);
    return;
  }

  // Initialize Supabase client now that it's available
  supabaseClient = getSupabaseClient();
  
  if (!supabaseClient) {
    console.error('Failed to initialize Supabase client');
    const rootEl = document.getElementById('root');
    if (rootEl) {
      rootEl.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; min-height: 100vh; background: linear-gradient(to br, #f3f4f6, #e5e7eb);">
          <div style="text-align: center; padding: 2rem; background: white; border-radius: 1rem; box-shadow: 0 10px 25px rgba(0,0,0,0.1);">
            <h1 style="font-size: 1.5rem; font-weight: bold; margin-bottom: 1rem; color: #ef4444;">⚠️ Supabase Initialization Error</h1>
            <p style="color: #6b7280; margin-bottom: 1rem;">Please refresh the page.</p>
            <p style="color: #9ca3af; font-size: 0.875rem;">If the problem persists, check your internet connection.</p>
          </div>
        </div>
      `;
    }
    return;
  }

  const rootEl = document.getElementById('root');
  if (!rootEl) {
    console.error('Root element not found');
    setTimeout(initApp, 100);
    return;
  }

  const root = ReactDOM.createRoot(rootEl);
  root.render(
    <AuthProvider>
      <App />
    </AuthProvider>
  );
}

// Start initialization when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
