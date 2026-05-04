import { BrowserRouter, Route, Routes } from "react-router-dom";

import { AppShell } from "@/app/AppShell";
import { AuthProvider } from "@/auth/AuthContext";
import { ProtectedRoute } from "@/auth/ProtectedRoute";
import { Toaster } from "@/components/ui/toaster";
import { AcceptInvitationPage } from "@/pages/AcceptInvitationPage";
import { AccessDeniedPage } from "@/pages/AccessDeniedPage";
import { AuditLogsPage } from "@/pages/AuditLogsPage";
import { CourseDetailPage } from "@/pages/CourseDetailPage";
import { CourseEditPage } from "@/pages/CourseEditPage";
import { CourseGradebookPage } from "@/pages/CourseGradebookPage";
import { CourseNewPage } from "@/pages/CourseNewPage";
import { GradeAccessLogPage } from "@/pages/GradeAccessLogPage";
import { CoursesPage } from "@/pages/CoursesPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { DepartmentDetailPage } from "@/pages/DepartmentDetailPage";
import { DepartmentEditPage } from "@/pages/DepartmentEditPage";
import { DepartmentNewPage } from "@/pages/DepartmentNewPage";
import { DepartmentsPage } from "@/pages/DepartmentsPage";
import { DefaultDashboardRedirect } from "@/pages/DefaultDashboardRedirect";
import { EmailLogsPage } from "@/pages/EmailLogsPage";
import { FacultyDetailPage } from "@/pages/FacultyDetailPage";
import { FacultyPage } from "@/pages/FacultyPage";
import { GuestDashboardPage } from "@/pages/GuestDashboardPage";
import { InvitationsPage } from "@/pages/InvitationsPage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SignInPage } from "@/pages/SignInPage";
import { StudentDashboardPage } from "@/pages/StudentDashboardPage";
import { StudentDetailPage } from "@/pages/StudentDetailPage";
import { StudentMyCoursesPage } from "@/pages/StudentMyCoursesPage";
import { StudentMyGradesPage } from "@/pages/StudentMyGradesPage";
import { StudentMyProfilePage } from "@/pages/StudentMyProfilePage";
import { StudentsPage } from "@/pages/StudentsPage";
import { TeacherAssistantCoursesPage } from "@/pages/TeacherAssistantCoursesPage";
import { TeacherAssistantDashboardPage } from "@/pages/TeacherAssistantDashboardPage";
import { TeacherAssistantDetailPage } from "@/pages/TeacherAssistantDetailPage";
import { TeacherAssistantsPage } from "@/pages/TeacherAssistantsPage";
import { TeacherCoursesPage } from "@/pages/TeacherCoursesPage";
import { TeacherDashboardPage } from "@/pages/TeacherDashboardPage";
import { TeacherDetailPage } from "@/pages/TeacherDetailPage";
import { TeacherStudentsPage } from "@/pages/TeacherStudentsPage";
import { TeachersPage } from "@/pages/TeachersPage";
import { UniversitiesPage } from "@/pages/UniversitiesPage";
import { UniversityDetailPage } from "@/pages/UniversityDetailPage";
import { UniversityEditPage } from "@/pages/UniversityEditPage";
import { UniversityNewPage } from "@/pages/UniversityNewPage";
import { UserDetailPage } from "@/pages/UserDetailPage";
import { UsersPage } from "@/pages/UsersPage";
import { UxStatesPage } from "@/pages/UxStatesPage";
import { AboutPage } from "@/public/AboutPage";
import { ContactPage } from "@/public/ContactPage";
import { FeaturesPage } from "@/public/FeaturesPage";
import { LandingPage } from "@/public/LandingPage";
import { PublicLayout } from "@/public/PublicLayout";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/sign-in" element={<SignInPage />} />
          <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
          <Route
            path="/app"
            element={
              <ProtectedRoute>
                <AppShell />
              </ProtectedRoute>
            }
          >
            <Route index element={<DefaultDashboardRedirect />} />
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="invitations" element={<InvitationsPage />} />
            <Route path="universities" element={<UniversitiesPage />} />
            <Route path="universities/new" element={<UniversityNewPage />} />
            <Route path="universities/:id" element={<UniversityDetailPage />} />
            <Route path="universities/:id/edit" element={<UniversityEditPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="users/:id" element={<UserDetailPage />} />
            <Route path="departments" element={<DepartmentsPage />} />
            <Route path="departments/new" element={<DepartmentNewPage />} />
            <Route path="departments/:id" element={<DepartmentDetailPage />} />
            <Route path="departments/:id/edit" element={<DepartmentEditPage />} />
            <Route path="courses" element={<CoursesPage />} />
            <Route path="courses/new" element={<CourseNewPage />} />
            <Route path="courses/:id" element={<CourseDetailPage />} />
            <Route path="courses/:id/edit" element={<CourseEditPage />} />
            <Route
              path="courses/:id/grades"
              element={<CourseGradebookPage />}
            />
            <Route path="students" element={<StudentsPage />} />
            <Route path="students/:id" element={<StudentDetailPage />} />
            <Route path="faculty" element={<FacultyPage />} />
            <Route path="faculty/:id" element={<FacultyDetailPage />} />
            <Route path="teachers" element={<TeachersPage />} />
            <Route path="teachers/:id" element={<TeacherDetailPage />} />
            <Route path="teacher-assistants" element={<TeacherAssistantsPage />} />
            <Route
              path="teacher-assistants/:id"
              element={<TeacherAssistantDetailPage />}
            />
            <Route path="teacher/dashboard" element={<TeacherDashboardPage />} />
            <Route path="teacher/courses" element={<TeacherCoursesPage />} />
            <Route path="teacher/students" element={<TeacherStudentsPage />} />
            <Route
              path="teacher-assistant/dashboard"
              element={<TeacherAssistantDashboardPage />}
            />
            <Route
              path="teacher-assistant/courses"
              element={<TeacherAssistantCoursesPage />}
            />
            <Route
              path="student/dashboard"
              element={<StudentDashboardPage />}
            />
            <Route
              path="student/my-courses"
              element={<StudentMyCoursesPage />}
            />
            <Route
              path="student/my-grades"
              element={<StudentMyGradesPage />}
            />
            <Route
              path="student/my-profile"
              element={<StudentMyProfilePage />}
            />
            <Route path="guest/dashboard" element={<GuestDashboardPage />} />
            <Route path="audit-logs" element={<AuditLogsPage />} />
            <Route
              path="audit-logs/grade-access"
              element={<GradeAccessLogPage />}
            />
            <Route path="email-logs" element={<EmailLogsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="ux" element={<UxStatesPage />} />
            <Route path="access-denied" element={<AccessDeniedPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
          <Route element={<PublicLayout />}>
            <Route index element={<LandingPage />} />
            <Route path="features" element={<FeaturesPage />} />
            <Route path="about" element={<AboutPage />} />
            <Route path="contact" element={<ContactPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
        <Toaster />
      </AuthProvider>
    </BrowserRouter>
  );
}
