import {
  Box,
  Button,
  Flex,
  FormControl,
  FormLabel,
  Heading,
  HStack,
  IconButton,
  Input,
  Text,
  Tooltip,
  VStack,
  useColorMode,
} from "@chakra-ui/react";
import { motion, useReducedMotion } from "framer-motion";
import { FormEvent, useState } from "react";
import { FiMoon, FiSun } from "react-icons/fi";

import { BRAND } from "./brand";
import Logo from "./Logo";

type LoginProps = {
  onSuccess: () => void;
};

const MotionBox = motion(Box);

function Login({ onSuccess }: LoginProps) {
  const reduce = useReducedMotion();
  const { colorMode, toggleColorMode } = useColorMode();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        onSuccess();
      } else {
        setError("Invalid email or password.");
        setBusy(false);
      }
    } catch {
      setError("Couldn't reach the server. Try again.");
      setBusy(false);
    }
  }

  return (
    <Flex
      minH="100vh"
      align="center"
      justify="center"
      px={4}
      position="relative"
      overflow="hidden"
      bg="surface.bg"
    >
      {/* Ambient focal glow — draws the eye to the card, adds depth. */}
      <Box
        aria-hidden
        position="absolute"
        inset={0}
        bgGradient="radial(60rem 40rem at 50% -10%, rgba(109,94,252,0.16), transparent 60%)"
        pointerEvents="none"
      />

      <Tooltip label={colorMode === "dark" ? "Light mode" : "Dark mode"} openDelay={300}>
        <IconButton
          aria-label="Toggle color mode"
          icon={colorMode === "dark" ? <FiSun /> : <FiMoon />}
          variant="ghost"
          color="ink.muted"
          position="absolute"
          top={4}
          right={4}
          onClick={toggleColorMode}
        />
      </Tooltip>

      <MotionBox
        as="form"
        onSubmit={handleSubmit}
        w="full"
        maxW="380px"
        bg="surface.panel"
        border="1px solid"
        borderColor="surface.border"
        borderRadius="xl"
        boxShadow="pop"
        p={{ base: 7, sm: 9 }}
        position="relative"
        initial={reduce ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      >
        <VStack spacing={6} align="stretch">
          <VStack spacing={3} align="center" textAlign="center">
            <Logo size={40} />
            <Box>
              <Heading size="md" letterSpacing="-0.02em">
                {BRAND.name}
              </Heading>
              <Text fontSize="sm" color="ink.muted" mt={1}>
                Sign in to your {BRAND.tagline.toLowerCase()}
              </Text>
            </Box>
          </VStack>

          <VStack spacing={4} align="stretch">
            <FormControl isRequired>
              <FormLabel fontSize="xs" color="ink.muted" mb={1.5}>
                Email
              </FormLabel>
              <Input
                type="email"
                value={email}
                autoFocus
                autoComplete="username"
                placeholder="you@company.com"
                onChange={(e) => setEmail(e.target.value)}
              />
            </FormControl>

            <FormControl isRequired>
              <FormLabel fontSize="xs" color="ink.muted" mb={1.5}>
                Password
              </FormLabel>
              <Input
                type="password"
                value={password}
                autoComplete="current-password"
                placeholder="••••••••"
                onChange={(e) => setPassword(e.target.value)}
              />
            </FormControl>

            {error && (
              <Text role="alert" color="red.300" fontSize="sm">
                {error}
              </Text>
            )}

            <Button type="submit" size="md" isLoading={busy} loadingText="Signing in">
              Continue
            </Button>
          </VStack>

          <HStack
            spacing={2}
            justify="center"
            pt={1}
            borderTop="1px solid"
            borderColor="surface.border"
          >
            <Text fontSize="xs" color="ink.subtle" pt={4} textAlign="center">
              Access is restricted. Accounts are provisioned by an administrator —
              there is no public sign-up.
            </Text>
          </HStack>
        </VStack>
      </MotionBox>
    </Flex>
  );
}

export default Login;
