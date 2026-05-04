import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "@/app/AppShell";
import { AuthProvider } from "@/auth/AuthContext";
import { ProtectedRoute } from "@/auth/ProtectedRoute";
import { Toaster } from "@/components/ui/toaster";
import { AcceptInvitationPage } from "@/pages/AcceptInvitationPage";
import { AccessDeniedPage } from "@/pages/AccessDeniedPage";
import { CourseDetailPage } from "@/pages/CourseDetailPage";
import { CourseEditPage } from "@/pages/CourseEditPage";
import { CourseNewPage } from "@/pages/CourseNewPage";
import { CoursesPage } from "@/pages/CoursesPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { DepartmentDetailPage } from "@/pages/DepartmentDetailPage";
import { DepartmentEditPage } from "@/pages/DepartmentEditPage";
import { DepartmentNewPage } from "@/pages/DepartmentNewPage";
import { DepartmentsPage } from "@/pages/DepartmentsPage";
import { InvitationsPage } from "@/pages/InvitationsPage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { SignInPage } from "@/pages/SignInPage";
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
            <Route index element={<Navigate to="dashboard" replace />} />
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
