import {
  Box,
  Button,
  Divider,
  FormControl,
  FormLabel,
  HStack,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalHeader,
  ModalOverlay,
  Text,
  VStack,
  useToast,
} from "@chakra-ui/react";
import { FormEvent, useState } from "react";

import * as api from "./api";
import { Me } from "./api";

type Props = {
  me: Me | null;
  isOpen: boolean;
  onClose: () => void;
  onUpdated: () => void;
};

function Profile({ me, isOpen, onClose, onUpdated }: Props) {
  const toast = useToast();
  const [name, setName] = useState(me?.name ?? "");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [savingPw, setSavingPw] = useState(false);

  function fail(e: unknown) {
    toast({
      title: e instanceof Error ? e.message : "Something went wrong",
      status: "error",
      duration: 3500,
    });
  }

  async function saveName(e: FormEvent) {
    e.preventDefault();
    setSavingName(true);
    try {
      await api.updateName(name.trim());
      onUpdated();
      toast({ title: "Name updated", status: "success", duration: 2000 });
    } catch (err) {
      fail(err);
    } finally {
      setSavingName(false);
    }
  }

  async function savePassword(e: FormEvent) {
    e.preventDefault();
    setSavingPw(true);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      toast({ title: "Password changed", status: "success", duration: 2000 });
    } catch (err) {
      fail(err);
    } finally {
      setSavingPw(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} isCentered size="md">
      <ModalOverlay bg="blackAlpha.600" />
      <ModalContent bg="surface.panel" border="1px solid" borderColor="surface.border">
        <ModalHeader fontSize="md">Profile</ModalHeader>
        <ModalCloseButton />
        <ModalBody pb={6}>
          <Text fontSize="xs" color="ink.subtle" fontFamily="mono" mb={5}>
            {me?.email}
          </Text>

          <Box as="form" onSubmit={saveName}>
            <FormControl>
              <FormLabel fontSize="xs" color="ink.muted">
                Display name
              </FormLabel>
              <HStack>
                <Input
                  size="sm"
                  value={name}
                  placeholder="Your name"
                  onChange={(e) => setName(e.target.value)}
                />
                <Button size="sm" type="submit" isLoading={savingName}>
                  Save
                </Button>
              </HStack>
            </FormControl>
          </Box>

          <Divider my={6} borderColor="surface.border" />

          <Box as="form" onSubmit={savePassword}>
            <Text fontSize="sm" fontWeight="semibold" mb={3}>
              Change password
            </Text>
            <VStack spacing={3} align="stretch">
              <FormControl isRequired>
                <FormLabel fontSize="xs" color="ink.muted">
                  Current password
                </FormLabel>
                <Input
                  size="sm"
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                />
              </FormControl>
              <FormControl isRequired>
                <FormLabel fontSize="xs" color="ink.muted">
                  New password
                </FormLabel>
                <Input
                  size="sm"
                  type="password"
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                />
              </FormControl>
              <Button
                size="sm"
                type="submit"
                alignSelf="flex-start"
                isLoading={savingPw}
                isDisabled={!current || next.length < 8}
              >
                Update password
              </Button>
            </VStack>
          </Box>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

export default Profile;
